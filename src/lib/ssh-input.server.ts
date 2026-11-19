// SSH tunnel input schema for the server (server functions and the REST API). Kept out of
// lib/ssh.ts so that the browser bundle does not include the validation code.
import { s } from './schema'
import { looksLikePrivateKey, SSH_KEY_MESSAGE } from './ssh'

export const sshInputSchema = s
  .object({
    host: s.string().trim().min(1, 'SSH host is required').max(255),
    port: s.number().int().min(1).max(65535).default(22),
    user: s.string().trim().min(1, 'SSH user is required').max(255),
    auth: s.enum(['password', 'key']),
    password: s.string().optional(),
    privateKey: s.string().optional(),
    passphrase: s.string().optional(),
    clearPassword: s.boolean().optional(),
    clearKey: s.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.privateKey && !looksLikePrivateKey(value.privateKey)) {
      ctx.addIssue({ code: 'custom', path: ['privateKey'], message: SSH_KEY_MESSAGE })
    }
  })

export const sshInputOptional = sshInputSchema.nullable().optional()
