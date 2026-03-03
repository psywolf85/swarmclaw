import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import path from 'path'
import fs from 'fs'
import { loadConnectors, loadSettings, UPLOAD_DIR } from '../storage'
import { genId } from '@/lib/id'
import { synthesizeElevenLabsMp3 } from '../elevenlabs'
import type { ToolBuildContext } from './context'

const CONNECTOR_ACTION_DEDUPE_TTL_MS = 30_000
const CONNECTOR_TURN_SEND_TTL_MS = 180_000
const AUTONOMOUS_OUTREACH_COOLDOWN_MS = 2 * 60 * 60 * 1000
const recentConnectorActionCache = new Map<string, { at: number; result: string }>()
const connectorTurnSendBudget = new Map<string, { count: number; at: number; lastResult?: string }>()
const autonomousOutreachBudget = new Map<string, { at: number; result?: string }>()

function pruneOldConnectorToolState(now: number): void {
  for (const [key, entry] of recentConnectorActionCache.entries()) {
    if (now - entry.at > CONNECTOR_ACTION_DEDUPE_TTL_MS) recentConnectorActionCache.delete(key)
  }
  for (const [key, entry] of connectorTurnSendBudget.entries()) {
    if (now - entry.at > CONNECTOR_TURN_SEND_TTL_MS) connectorTurnSendBudget.delete(key)
  }
  for (const [key, entry] of autonomousOutreachBudget.entries()) {
    if (now - entry.at > AUTONOMOUS_OUTREACH_COOLDOWN_MS) autonomousOutreachBudget.delete(key)
  }
}

function parseLatestUserTurn(
  session: { messages?: Array<Record<string, unknown>> } | null | undefined,
): { text: string; time: number } {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i]
    if (String(msg?.role || '') !== 'user') continue
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    const time = typeof msg.time === 'number' ? msg.time : 0
    return { text, time }
  }
  return { text: '', time: 0 }
}

function userExplicitlyWantsMultipleOutbound(userText: string): boolean {
  if (!userText) return false
  const text = userText.toLowerCase()
  return /\b(both|multiple|all of them|all numbers|two messages|three messages|each number|every number|and also|plus also|send again|resend)\b/.test(text)
}

function userExplicitlyRequestedFollowup(userText: string): boolean {
  if (!userText) return false
  const text = userText.toLowerCase()
  if (/connector_message_tool/.test(text) && /(schedule_followup|followupmessage|followup|delaysec|follow.?up)/.test(text)) return true
  return /\b(follow[ -]?up|check[ -]?in|remind(?: me)?|later|tomorrow|in \d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days))\b/.test(text)
}

function isAutonomousSystemTurn(userText: string): boolean {
  if (!userText) return false
  const text = userText.toUpperCase()
  return text.includes('AGENT_HEARTBEAT_WAKE')
    || text.includes('SWARM_MAIN_MISSION_TICK')
    || text.includes('SWARM_MAIN_AUTO_FOLLOWUP')
    || text.includes('SWARM_HEARTBEAT_CHECK')
}

function isSignificantOutreachText(raw: string): boolean {
  const text = (raw || '').trim().toLowerCase()
  if (text.length < 12) return false
  if (/\b(just checking in|checking in|touching base|quick check-in|hope you'?re well|any updates\??)\b/.test(text)) {
    return false
  }
  return /\b(completed|complete|done|finished|failed|failure|error|blocked|urgent|important|deadline|overdue|incident|warning|reminder|birthday|anniversary|milestone|congrats|congratulations|celebrate|payment|invoice|appointment|meeting)\b/.test(text)
}

function isUrgentOutreachText(raw: string): boolean {
  const text = (raw || '').toLowerCase()
  return /\b(urgent|immediately|asap|critical|incident|outage|failed|failure|blocked|overdue|deadline)\b/.test(text)
}

function buildConnectorActionKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => String(part ?? '')).join('|')
}

function normalizeDedupedReplayResult(raw: string, fallback: { connectorId: string; platform: string; to: string }): string {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    const record = parsed as Record<string, unknown>
    if (String(record.status || '') === 'deduped') {
      return JSON.stringify({
        status: 'sent',
        connectorId: String(record.connectorId || fallback.connectorId),
        platform: String(record.platform || fallback.platform),
        to: String(record.to || fallback.to),
        deduped: true,
      })
    }
    return raw
  } catch {
    return JSON.stringify({
      status: 'sent',
      connectorId: fallback.connectorId,
      platform: fallback.platform,
      to: fallback.to,
      deduped: true,
    })
  }
}

/** Resolve /api/uploads/filename URLs to actual disk paths */
function resolveUploadUrl(url: string | undefined): { mediaPath: string; mimeType?: string } | null {
  if (!url) return null
  const match = url.match(/^\/api\/uploads\/([^?#]+)/)
  if (!match) return null
  // Decode URL-encoded filenames (e.g. from encodeURIComponent) before sanitizing
  let decoded: string
  try { decoded = decodeURIComponent(match[1]) } catch { decoded = match[1] }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(UPLOAD_DIR, safeName)
  if (!fs.existsSync(filePath)) return null
  return { mediaPath: filePath }
}

function normalizeWhatsAppTarget(input: string): string {
  const raw = input.trim()
  if (!raw) return raw
  if (raw.includes('@')) return raw
  let cleaned = raw.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    cleaned = `44${cleaned.slice(1)}`
  }
  cleaned = cleaned.replace(/[^\d]/g, '')
  return cleaned ? `${cleaned}@s.whatsapp.net` : raw
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function pickChannelTarget(params: {
  connector: { config?: Record<string, string> }
  to?: string
  recentChannelId: string | null
}): { channelId: string; error?: string } {
  let channelId = params.to?.trim() || ''
  const connector = params.connector

  if (!channelId) {
    const outbound = connector.config?.outboundJid?.trim()
    if (outbound) channelId = outbound
  }
  if (!channelId) {
    const outbound = connector.config?.outboundTarget?.trim()
    if (outbound) channelId = outbound
  }
  if (!channelId && params.recentChannelId) {
    channelId = params.recentChannelId
  }
  if (!channelId) {
    const allowed = parseCsv(connector.config?.allowedJids)
    if (allowed.length) channelId = allowed[0]
  }
  if (!channelId) {
    const allowed = parseCsv(connector.config?.allowFrom)
    if (allowed.length) channelId = allowed[0]
  }
  if (!channelId) {
    const knownTargets = [
      connector.config?.outboundJid?.trim(),
      connector.config?.outboundTarget?.trim(),
      ...parseCsv(connector.config?.allowedJids),
      ...parseCsv(connector.config?.allowFrom),
    ].filter(Boolean) as string[]
    const unique = [...new Set(knownTargets)]
    if (unique.length) {
      return {
        channelId: '',
        error: `Error: no default outbound target is set, but the connector has ${unique.length} configured number(s)/target(s): ${JSON.stringify(unique)}. Ask the user which one to send to, then re-call with the "to" parameter set to their choice.`,
      }
    }
    return {
      channelId: '',
      error: 'Error: no target recipient configured and no known contacts on this connector. Ask the user for the recipient number/ID, then re-call with the "to" parameter. They can also configure "allowedJids" or "outboundJid" in the connector settings.',
    }
  }
  return { channelId }
}

function resolveConnectorMediaInput(params: {
  cwd: string
  mediaPath?: string
  imageUrl?: string
  fileUrl?: string
}): { mediaPath?: string; imageUrl?: string; fileUrl?: string; error?: string } {
  let resolvedMediaPath = params.mediaPath?.trim() || undefined
  let resolvedImageUrl = params.imageUrl?.trim() || undefined
  let resolvedFileUrl = params.fileUrl?.trim() || undefined

  if (resolvedMediaPath && !path.isAbsolute(resolvedMediaPath) && !resolvedMediaPath.startsWith('/api/uploads/')) {
    const candidatePaths = [
      path.resolve(params.cwd, resolvedMediaPath),
      path.resolve(params.cwd, 'uploads', resolvedMediaPath),
      path.join(UPLOAD_DIR, resolvedMediaPath),
      path.join(UPLOAD_DIR, path.basename(resolvedMediaPath)),
    ]
    const found = candidatePaths.find((p) => fs.existsSync(p))
    if (found) {
      resolvedMediaPath = found
    } else {
      return {
        error: `Error: File not found. Tried: ${candidatePaths.join(', ')}. Use an absolute path or ensure the file exists in the session workspace.`,
      }
    }
  }

  if (!resolvedMediaPath) {
    const fromImage = resolveUploadUrl(resolvedImageUrl)
    if (fromImage) {
      resolvedMediaPath = fromImage.mediaPath
      resolvedImageUrl = undefined
    }
    const fromFile = resolveUploadUrl(resolvedFileUrl)
    if (fromFile) {
      resolvedMediaPath = fromFile.mediaPath
      resolvedFileUrl = undefined
    }
  }

  return {
    mediaPath: resolvedMediaPath,
    imageUrl: resolvedImageUrl,
    fileUrl: resolvedFileUrl,
  }
}

export function buildConnectorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { hasTool } = bctx

  if (hasTool('manage_connectors')) {
    const settings = loadSettings()
    const hasElevenLabsKey = !!String(settings.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '').trim()
    const voiceNoteToolEnabled = settings.elevenLabsEnabled === true && hasElevenLabsKey
    const actionSchema = voiceNoteToolEnabled
      ? z.enum([
        'list_running',
        'list_targets',
        'start',
        'stop',
        'send',
        'send_voice_note',
        'schedule_followup',
        'message_react',
        'message_edit',
        'message_delete',
        'message_pin',
      ] as const)
      : z.enum([
        'list_running',
        'list_targets',
        'start',
        'stop',
        'send',
        'schedule_followup',
        'message_react',
        'message_edit',
        'message_delete',
        'message_pin',
      ] as const)
    tools.push(
      tool(
        async ({
          action,
          connectorId,
          platform,
          to,
          message,
          voiceText,
          voiceId,
          imageUrl,
          fileUrl,
          mediaPath,
          mimeType,
          fileName,
          caption,
          delaySec,
          followUpMessage,
          followUpDelaySec,
          approved,
          ptt,
        }) => {
          try {
            const actionName = String(action)
            const { listRunningConnectors, sendConnectorMessage, getConnectorRecentChannelId, scheduleConnectorFollowUp } = await import('../connectors/manager')
            const running = listRunningConnectors(platform || undefined)

            if (actionName === 'list_running' || actionName === 'list_targets') {
              return JSON.stringify(running)
            }

            if (actionName === 'start') {
              if (!connectorId) {
                // If no ID given, list available connectors to start
                const allConnectors = loadConnectors()
                const stopped = Object.values(allConnectors)
                  .filter((c) => !platform || c.platform === platform)
                  .filter((c) => !running.find((r) => r.id === c.id))
                  .map((c) => ({ id: c.id, name: c.name, platform: c.platform }))
                if (!stopped.length) return 'All connectors are already running.'
                return `Error: connectorId is required. Stopped connectors available to start: ${JSON.stringify(stopped)}`
              }
              const { startConnector: doStart } = await import('../connectors/manager')
              await doStart(connectorId)
              return JSON.stringify({ status: 'started', connectorId })
            }

            if (actionName === 'stop') {
              if (!connectorId) return 'Error: connectorId is required for stop action.'
              const { stopConnector: doStop } = await import('../connectors/manager')
              await doStop(connectorId)
              return JSON.stringify({ status: 'stopped', connectorId })
            }

            const resolveSelectedConnector = () => {
              if (!running.length) {
                const allConnectors = loadConnectors()
                const configured = Object.values(allConnectors)
                  .filter((c) => !platform || c.platform === platform)
                  .map((c) => ({ id: c.id, name: c.name, platform: c.platform, agentId: c.agentId || null }))
                if (configured.length) {
                  return {
                    error: `Error: no running connectors${platform ? ` for platform "${platform}"` : ''}, but ${configured.length} configured connector(s) found: ${JSON.stringify(configured)}. These connectors exist but are not currently started. Ask the user if they'd like you to start one (use action "start" with the connectorId), then retry the send.`,
                  }
                }
                return {
                  error: `Error: no running connectors${platform ? ` for platform "${platform}"` : ''}. No connectors are configured for this platform either — the user needs to set one up in the Connectors panel first.`,
                }
              }
              const selected = connectorId
                ? running.find((c) => c.id === connectorId)
                : running[0]
              if (!selected) return { error: `Error: running connector not found: ${connectorId}` }
              const connectors = loadConnectors()
              const connector = connectors[selected.id]
              if (!connector) return { error: `Error: connector not found: ${selected.id}` }
              return { selected, connector }
            }

            if (actionName === 'send' || actionName === 'send_voice_note' || actionName === 'schedule_followup') {
              const settings = loadSettings()
              if (settings.safetyRequireApprovalForOutbound === true && approved !== true) {
                return 'Error: outbound connector sends require explicit approval. Re-run with approved=true after user confirmation.'
              }
              const now = Date.now()
              pruneOldConnectorToolState(now)
              const resolved = resolveSelectedConnector()
              if ('error' in resolved) return resolved.error
              const { selected, connector } = resolved

              const target = pickChannelTarget({
                connector,
                to,
                recentChannelId: getConnectorRecentChannelId(selected.id),
              })
              if (target.error) return target.error

              let channelId = target.channelId
              if (connector.platform === 'whatsapp') channelId = normalizeWhatsAppTarget(channelId)

              const currentSession = bctx.resolveCurrentSession()
              const latestUserTurn = parseLatestUserTurn(currentSession)
              const sessionId = bctx.ctx?.sessionId || currentSession?.id || 'unknown-session'
              const turnKey = buildConnectorActionKey([sessionId, latestUserTurn.time || 'no-user-turn'])
              const multiOutboundAllowed = userExplicitlyWantsMultipleOutbound(latestUserTurn.text)
              const followupExplicitlyRequested = userExplicitlyRequestedFollowup(latestUserTurn.text)
              const autonomousTurn = isAutonomousSystemTurn(latestUserTurn.text)
              const existingBudget = connectorTurnSendBudget.get(turnKey)
              if (
                !multiOutboundAllowed
                && existingBudget
                && now - existingBudget.at <= CONNECTOR_TURN_SEND_TTL_MS
                && existingBudget.count >= 1
              ) {
                if (existingBudget.lastResult) {
                  return normalizeDedupedReplayResult(existingBudget.lastResult, {
                    connectorId: selected.id,
                    platform: selected.platform,
                    to: channelId,
                  })
                }
                return JSON.stringify({
                  status: 'sent',
                  connectorId: selected.id,
                  platform: selected.platform,
                  to: channelId,
                  deduped: true,
                })
              }

              if (actionName === 'send_voice_note') {
                if (!voiceNoteToolEnabled) {
                  return 'Error: send_voice_note is unavailable. Enable ElevenLabs in Settings > Voice and set a valid API key.'
                }
                const ttsText = (voiceText || message || '').trim()
                if (!ttsText) return 'Error: voiceText or message is required for send_voice_note action.'
                const voiceActionKey = buildConnectorActionKey([
                  sessionId,
                  actionName,
                  selected.id,
                  channelId,
                  ttsText,
                  voiceId?.trim() || '',
                  fileName?.trim() || '',
                  caption?.trim() || '',
                  ptt ?? true,
                ])
                const cachedVoice = recentConnectorActionCache.get(voiceActionKey)
                if (cachedVoice && now - cachedVoice.at <= CONNECTOR_ACTION_DEDUPE_TTL_MS) {
                  return cachedVoice.result
                }
                const audioBuffer = await synthesizeElevenLabsMp3({ text: ttsText, voiceId: voiceId?.trim() || undefined })
                const voiceFileName = `${Date.now()}-${genId()}-voicenote.mp3`
                const voicePath = path.join(UPLOAD_DIR, voiceFileName)
                fs.writeFileSync(voicePath, audioBuffer)

                const sent = await sendConnectorMessage({
                  connectorId: selected.id,
                  channelId,
                  text: '',
                  mediaPath: voicePath,
                  mimeType: 'audio/mpeg',
                  fileName: fileName?.trim() || 'voicenote.mp3',
                  caption: caption?.trim() || undefined,
                  ptt: ptt ?? true,
                })
                const result = JSON.stringify({
                  status: 'voice_sent',
                  connectorId: sent.connectorId,
                  platform: sent.platform,
                  to: sent.channelId,
                  messageId: sent.messageId || null,
                  voiceFile: voicePath,
                })
                connectorTurnSendBudget.set(turnKey, {
                  count: (existingBudget?.count || 0) + 1,
                  at: now,
                  lastResult: result,
                })
                recentConnectorActionCache.set(voiceActionKey, { at: now, result })
                return result
              }

              const media = resolveConnectorMediaInput({
                cwd: bctx.cwd,
                mediaPath,
                imageUrl,
                fileUrl,
              })
              if (media.error) return media.error

              const hasText = !!message?.trim()
              const hasMedia = !!media.mediaPath || !!media.imageUrl || !!media.fileUrl
              if (actionName === 'send' && !hasText && !hasMedia) {
                return 'Error: message, media URL, or mediaPath is required for send action.'
              }

              let followUpText = followUpMessage?.trim() || ''
              const followDelaySec = Number.isFinite(followUpDelaySec) ? Number(followUpDelaySec) : 300

              const proactivePayload = followUpText || message?.trim() || ''
              const significantAutonomousOutreach = autonomousTurn && isSignificantOutreachText(proactivePayload)
              const urgentAutonomousOutreach = autonomousTurn && isUrgentOutreachText(proactivePayload)
              const outreachBudgetKey = buildConnectorActionKey([selected.id, channelId])
              const priorAutonomousOutreach = autonomousOutreachBudget.get(outreachBudgetKey)
              if (
                autonomousTurn
                && significantAutonomousOutreach
                && priorAutonomousOutreach
                && !urgentAutonomousOutreach
                && now - priorAutonomousOutreach.at <= AUTONOMOUS_OUTREACH_COOLDOWN_MS
              ) {
                if (priorAutonomousOutreach.result) {
                  return normalizeDedupedReplayResult(priorAutonomousOutreach.result, {
                    connectorId: selected.id,
                    platform: selected.platform,
                    to: channelId,
                  })
                }
                return JSON.stringify({
                  status: 'sent',
                  connectorId: selected.id,
                  platform: selected.platform,
                  to: channelId,
                  deduped: true,
                })
              }

              if (followUpText && !followupExplicitlyRequested && !significantAutonomousOutreach) {
                followUpText = ''
              }

              if (actionName === 'schedule_followup') {
                if (!followupExplicitlyRequested && !significantAutonomousOutreach) {
                  return 'Error: schedule_followup requires either an explicit user request or a significant autonomous event.'
                }
                const payload = followUpText || message?.trim() || ''
                if (!payload) return 'Error: followUpMessage or message is required for schedule_followup action.'
                const scheduleActionKey = buildConnectorActionKey([
                  sessionId,
                  actionName,
                  selected.id,
                  channelId,
                  payload,
                  Number.isFinite(delaySec) ? Number(delaySec) : followDelaySec,
                ])
                const cachedSchedule = recentConnectorActionCache.get(scheduleActionKey)
                if (cachedSchedule && now - cachedSchedule.at <= CONNECTOR_ACTION_DEDUPE_TTL_MS) {
                  return cachedSchedule.result
                }
                const scheduled = scheduleConnectorFollowUp({
                  connectorId: selected.id,
                  channelId,
                  text: payload,
                  delaySec: Number.isFinite(delaySec) ? Number(delaySec) : followDelaySec,
                })
                const result = JSON.stringify({
                  status: 'followup_scheduled',
                  connectorId: selected.id,
                  platform: selected.platform,
                  to: channelId,
                  followUpId: scheduled.followUpId,
                  sendAt: scheduled.sendAt,
                })
                connectorTurnSendBudget.set(turnKey, {
                  count: (existingBudget?.count || 0) + 1,
                  at: now,
                  lastResult: result,
                })
                if (autonomousTurn && significantAutonomousOutreach) {
                  autonomousOutreachBudget.set(outreachBudgetKey, { at: now, result })
                }
                recentConnectorActionCache.set(scheduleActionKey, { at: now, result })
                return result
              }

              const sendActionKey = buildConnectorActionKey([
                sessionId,
                actionName,
                selected.id,
                channelId,
                message?.trim() || '',
                media.mediaPath || '',
                media.imageUrl || '',
                media.fileUrl || '',
                mimeType?.trim() || '',
                fileName?.trim() || '',
                caption?.trim() || '',
                ptt ?? '',
                followUpText,
                followDelaySec,
              ])
              const cachedSend = recentConnectorActionCache.get(sendActionKey)
              if (cachedSend && now - cachedSend.at <= CONNECTOR_ACTION_DEDUPE_TTL_MS) {
                return cachedSend.result
              }

              const sent = await sendConnectorMessage({
                connectorId: selected.id,
                channelId,
                text: message?.trim() || '',
                imageUrl: media.imageUrl,
                fileUrl: media.fileUrl,
                mediaPath: media.mediaPath,
                mimeType: mimeType?.trim() || undefined,
                fileName: fileName?.trim() || undefined,
                caption: caption?.trim() || undefined,
                ptt: ptt ?? undefined,
              })

              let followup: { followUpId: string; sendAt: number } | null = null
              if (followUpText) {
                followup = scheduleConnectorFollowUp({
                  connectorId: selected.id,
                  channelId,
                  text: followUpText,
                  delaySec: followDelaySec,
                })
              }

              const result = JSON.stringify({
                status: 'sent',
                connectorId: sent.connectorId,
                platform: sent.platform,
                to: sent.channelId,
                messageId: sent.messageId || null,
                ...(followup
                  ? {
                      followUpId: followup.followUpId,
                      followUpSendAt: followup.sendAt,
                    }
                  : {}),
              })
              connectorTurnSendBudget.set(turnKey, {
                count: (existingBudget?.count || 0) + 1,
                at: now,
                lastResult: result,
              })
              if (autonomousTurn && significantAutonomousOutreach) {
                autonomousOutreachBudget.set(outreachBudgetKey, { at: now, result })
              }
              recentConnectorActionCache.set(sendActionKey, { at: now, result })
              return result
            }

            if (actionName === 'message_react' || actionName === 'message_edit' || actionName === 'message_pin' || actionName === 'message_delete') {
              if (!connectorId) return 'Error: connectorId is required for rich messaging actions.'
              const { getRunningInstance } = await import('../connectors/manager')
              const inst = getRunningInstance(connectorId)
              if (!inst) return `Error: connector "${connectorId}" is not running.`

              const targetChannel = to?.trim() || ''
              const targetMessageId = message?.trim() || ''
              if (!targetMessageId) return 'Error: message parameter (used as messageId) is required for rich messaging actions.'

              try {
                if (actionName === 'message_react') {
                  if (!inst.sendReaction) return 'Error: this connector does not support reactions.'
                  const emoji = caption?.trim() || '👍'
                  await inst.sendReaction(targetChannel, targetMessageId, emoji)
                  return JSON.stringify({ status: 'reacted', connectorId, messageId: targetMessageId, emoji })
                }
                if (actionName === 'message_edit') {
                  if (!inst.editMessage) return 'Error: this connector does not support message editing.'
                  const newText = caption?.trim() || ''
                  if (!newText) return 'Error: caption (new text) is required for message_edit.'
                  await inst.editMessage(targetChannel, targetMessageId, newText)
                  return JSON.stringify({ status: 'edited', connectorId, messageId: targetMessageId })
                }
                if (actionName === 'message_delete') {
                  if (!inst.deleteMessage) return 'Error: this connector does not support message deletion.'
                  await inst.deleteMessage(targetChannel, targetMessageId)
                  return JSON.stringify({ status: 'deleted', connectorId, messageId: targetMessageId })
                }
                if (actionName === 'message_pin') {
                  if (!inst.pinMessage) return 'Error: this connector does not support message pinning.'
                  await inst.pinMessage(targetChannel, targetMessageId)
                  return JSON.stringify({ status: 'pinned', connectorId, messageId: targetMessageId })
                }
              } catch (err: unknown) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`
              }
            }

            return 'Unknown action. Use list_running, list_targets, start, stop, send, send_voice_note, schedule_followup, or message_* actions.'
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'connector_message_tool',
          description: voiceNoteToolEnabled
            ? 'Manage and send messages through chat platform connectors (WhatsApp, Telegram, Slack, Discord, etc.). Use "start"/"stop" to manage connector lifecycle, "list_running"/"list_targets" to discover available connectors and recipients, "send" to deliver text/media, "send_voice_note" to synthesize and send audio via ElevenLabs, "schedule_followup" for delayed check-ins, and rich actions (react, edit, delete, pin) for message management. When a send fails because no connector is running, check if one is configured and offer to start it. When no target is set, list available configured numbers and ask the user which to send to.'
            : 'Manage and send messages through chat platform connectors (WhatsApp, Telegram, Slack, Discord, etc.). Use "start"/"stop" to manage connector lifecycle, "list_running"/"list_targets" to discover available connectors and recipients, "send" to deliver text/media, "schedule_followup" for delayed check-ins, and rich actions (react, edit, delete, pin) for message management. Voice-note sending appears only when ElevenLabs is enabled with an API key in Settings > Voice. When a send fails because no connector is running, check if one is configured and offer to start it. When no target is set, list available configured numbers and ask the user which to send to.',
          schema: z.object({
            action: actionSchema.describe('connector messaging action'),
            connectorId: z.string().optional().describe('Optional connector id. Defaults to the first running connector (or first for selected platform).'),
            platform: z.string().optional().describe('Optional platform filter (whatsapp, telegram, slack, discord, bluebubbles, etc.).'),
            to: z.string().optional().describe('Target channel id / recipient. For WhatsApp, phone number or full JID.'),
            message: z.string().optional().describe('Message text to send. Required for send unless media is provided. Used as fallback for send_voice_note/schedule_followup when voiceText/followUpMessage are omitted.'),
            voiceText: z.string().optional().describe('Text to synthesize for send_voice_note. Uses message when omitted.'),
            voiceId: z.string().optional().describe('Optional ElevenLabs voice override for send_voice_note.'),
            imageUrl: z.string().optional().describe('Optional public image URL to attach/send where platform supports media.'),
            fileUrl: z.string().optional().describe('Optional public file URL to attach/send where platform supports documents.'),
            mediaPath: z.string().optional().describe('Absolute local file path to send (e.g. a screenshot). Auto-detects mime type from extension. Takes priority over imageUrl/fileUrl.'),
            mimeType: z.string().optional().describe('Optional MIME type for mediaPath or fileUrl.'),
            fileName: z.string().optional().describe('Optional display file name for mediaPath or fileUrl.'),
            caption: z.string().optional().describe('Optional caption used with image/file sends.'),
            delaySec: z.number().optional().describe('Delay in seconds for schedule_followup.'),
            followUpMessage: z.string().optional().describe('Optional delayed follow-up text (for send) or primary text for schedule_followup.'),
            followUpDelaySec: z.number().optional().describe('Delay in seconds for followUpMessage when action=send. Default 300 seconds.'),
            ptt: z.boolean().optional().describe('Send audio as a WhatsApp voice note (push-to-talk). Defaults to true for audio files.'),
            approved: z.boolean().optional().describe('Set true to explicitly confirm outbound send when safetyRequireApprovalForOutbound is enabled.'),
          }),
        },
      ),
    )
  }

  return tools
}
