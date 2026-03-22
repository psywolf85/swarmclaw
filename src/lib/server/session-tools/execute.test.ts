import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, buildCredentialEnv } from './credential-env'

describe('credential-env', () => {
  describe('redactSecrets', () => {
    it('redacts secret values from text', () => {
      const secrets = ['sk-abc123456789']
      const text = 'Response: Bearer sk-abc123456789 was used'
      const result = redactSecrets(text, secrets)
      assert.equal(result, 'Response: Bearer [REDACTED] was used')
    })

    it('skips secrets shorter than 5 characters', () => {
      const secrets = ['abc']
      const text = 'Contains abc value'
      const result = redactSecrets(text, secrets)
      assert.equal(result, 'Contains abc value')
    })

    it('handles empty secrets list', () => {
      const text = 'No secrets here'
      const result = redactSecrets(text, [])
      assert.equal(result, 'No secrets here')
    })

    it('handles empty text', () => {
      const result = redactSecrets('', ['secret123'])
      assert.equal(result, '')
    })

    it('redacts multiple occurrences', () => {
      const secrets = ['mytoken12345']
      const text = 'First: mytoken12345, Second: mytoken12345'
      const result = redactSecrets(text, secrets)
      assert.equal(result, 'First: [REDACTED], Second: [REDACTED]')
    })

    it('redacts multiple different secrets', () => {
      const secrets = ['secret_one_value', 'secret_two_value']
      const text = 'Key1=secret_one_value Key2=secret_two_value'
      const result = redactSecrets(text, secrets)
      assert.equal(result, 'Key1=[REDACTED] Key2=[REDACTED]')
    })
  })

  describe('buildCredentialEnv', () => {
    it('returns empty env for empty credential list', () => {
      const result = buildCredentialEnv([])
      assert.deepEqual(result, { env: {}, secrets: [] })
    })

    it('handles non-existent credential IDs gracefully', () => {
      const result = buildCredentialEnv(['nonexistent-id'])
      assert.deepEqual(result, { env: {}, secrets: [] })
    })
  })
})
