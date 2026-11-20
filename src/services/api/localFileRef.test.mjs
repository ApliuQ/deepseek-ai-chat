import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalFileRef, toLocalFileRef } from '../localFileRef.ts'

test('local file references preserve IDs and distinguish server references', () => {
  for (const id of ['attachment-1', '', 'local:nested']) {
    assert.equal(toLocalFileRef(id), `local:${id}`)
    assert.equal(isLocalFileRef(toLocalFileRef(id)), true)
  }
  for (const ref of ['', 'file-123', 'not-local:123', 'LOCAL:123']) {
    assert.equal(isLocalFileRef(ref), false)
  }
})
