import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

describe('MessageBubble', () => {
  it('renders media-only assistant turns without an empty markdown body', async () => {
    const messageBubbleModule = await import('./message-bubble.tsx') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: '',
          time: Date.now(),
          kind: 'chat',
          toolEvents: [
            {
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/test-screenshot.png)',
            },
          ],
        },
        assistantName: 'Hal2k-3',
        agentName: 'Hal2k-3',
      }),
    )

    assert.match(html, /\/api\/uploads\/test-screenshot\.png/)
    assert.doesNotMatch(html, /msg-content text-\[15px]/)
    assert.doesNotMatch(html, /streaming-cursor/)
  })

  it('renders upload-linked screenshots inline without duplicating them at the bottom', async () => {
    const messageBubbleModule = await import('./message-bubble.tsx') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: [
            "I've sent you two screenshots:",
            '',
            '1. **Sunflower** (Download: [screenshot-1.png](/api/uploads/1773570599000-screenshot-1.png))',
            '',
            '2. **Quantum** (Download: [screenshot-2.png](/api/uploads/1773570616255-screenshot-2.png))',
          ].join('\n'),
          time: Date.now(),
          kind: 'chat',
          toolEvents: [
            {
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/screenshot-1.png)',
            },
            {
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/screenshot-2.png)',
            },
            {
              name: 'send_file',
              input: '{"filePath":"/api/uploads/screenshot-1.png"}',
              output: '[Download screenshot-1.png](/api/uploads/1773570599000-screenshot-1.png)',
            },
            {
              name: 'send_file',
              input: '{"filePath":"/api/uploads/screenshot-2.png"}',
              output: '[Download screenshot-2.png](/api/uploads/1773570616255-screenshot-2.png)',
            },
          ],
        },
        assistantName: 'Hal2k-3',
        agentName: 'Hal2k-3',
      }),
    )

    assert.match(html, /screenshot-1\.png/)
    assert.match(html, /screenshot-2\.png/)
    assert.equal((html.match(/<img /g) || []).length, 2)
    assert.doesNotMatch(html, /flex flex-col gap-2 mt-3"><\/div>/)
  })

  it('renders connector-delivery transcript as the primary message content', async () => {
    const messageBubbleModule = await import('./message-bubble.tsx') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: 'Message delivered.',
          time: Date.now(),
          kind: 'connector-delivery',
          source: {
            platform: 'telegram',
            connectorId: 'connector-1',
            connectorName: 'Telegram',
            channelId: 'chat-1',
            senderId: 'user-1',
            senderName: 'Wayde',
            deliveryTranscript: 'I tested the platform and sent the update through Telegram.',
            deliveryMode: 'text',
          },
        },
        assistantName: 'Hal2k',
        agentName: 'Hal2k',
      }),
    )

    assert.match(html, /Delivered via connector/)
    assert.match(html, /I tested the platform and sent the update through Telegram\./)
    assert.doesNotMatch(html, />Message delivered\.<\/p>/)
  })
})
