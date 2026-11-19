import { describe, expect, test } from 'bun:test'
import { s, toJSONSchema, Schema, SchemaError, type Infer, type InferInput } from './schema'
import { sshInputOptional, sshInputSchema } from './ssh-input.server'
import * as v1 from '@/server/http/v1-api.server'
import * as auth from '@/server/http/auth-api.server'
import * as validators from '@/api/validators'
import { FIXTURE, revive } from './__fixtures__/schema-compat'
import { parseConfigText } from '@/server/config.server'
import { parseImportParams } from '@/server/import-csv.server'
import { parseTableExportRequest } from '@/server/export.server'

// ---------------------------------------------------------------------------
// The compatibility fixture: what zod 4 did for each schema and input (see schema-compat.json).
// ---------------------------------------------------------------------------

/** Our schemas, under the names the fixture uses. The feature gallery comes first. */
const registry: Record<string, Schema<unknown, unknown>> = {}
function define(name: string, schema: Schema<unknown, unknown>) {
  registry[name] = schema
}

define('feat.string', s.string())
define('feat.string.trim.min.max', s.string().trim().min(2).max(4))
define('feat.string.min.msg', s.string().min(1, 'Name is required.'))
define('feat.string.max.msg', s.string().max(3, 'too long'))
define('feat.string.regex', s.string().regex(/^SHA256:[A-Za-z0-9+/]+$/, 'must look like SHA256'))
define('feat.string.regex.default', s.string().regex(/^a+$/))
define('feat.string.describe', s.string().min(1).describe('Connection id, or its exact name.'))
define('feat.string.optional', s.string().optional())
define('feat.string.nullable', s.string().nullable())
define('feat.string.nullable.optional', s.string().nullable().optional())
define('feat.string.chain', s.string().trim().min(1).max(255).nullable().optional())
define('feat.number', s.number())
define('feat.number.int', s.number().int())
define('feat.number.int.min.max', s.number().int().min(1).max(65535))
define('feat.number.positive', s.number().int().positive())
define('feat.number.min.max.float', s.number().min(0.5).max(2))
define('feat.number.default', s.number().int().min(1).max(65535).default(22))
define('feat.boolean', s.boolean())
define('feat.boolean.default', s.boolean().default(false))
define('feat.enum', s.enum(['off', 'read', 'write']))
define('feat.enum.optional', s.enum(['a', 'b']).optional())
define('feat.literal', s.literal('all'))
define('feat.null', s.null())
define('feat.unknown', s.unknown())
define('feat.unknown.optional', s.unknown().optional())
define('feat.array', s.array(s.string()))
define('feat.array.min.max', s.array(s.number()).min(1).max(2))
define('feat.array.default', s.array(s.string().min(1)).default([]))
define('feat.array.objects.max', s.array(s.object({ column: s.string(), value: s.string().optional() })).max(2))
define('feat.union', s.union([s.literal('all'), s.array(s.string().trim().min(1)).min(1)]))
define('feat.union.nullable.num', s.union([s.null(), s.number().int().min(1).max(3650)]).optional())
define('feat.union.prim', s.union([s.string(), s.number()]))
define('feat.record', s.record(s.string(), s.union([s.string(), s.boolean(), s.null()])))
define('feat.record.values.array', s.record(s.string(), s.array(s.number())))
define('feat.object', s.object({ a: s.string(), b: s.number().optional(), c: s.boolean().default(false) }))
define('feat.strictObject', s.strictObject({ a: s.string(), b: s.number().optional() }))
define('feat.object.empty', s.object({}))
define('feat.strictObject.empty', s.strictObject({}))
define('feat.object.extend', s.object({ id: s.string() }).extend({ n: s.number().int() }))
define('feat.object.pick', s.object({ a: s.string(), b: s.string(), c: s.number() }).pick({ a: true, c: true }))
define(
  'feat.object.nested',
  s.object({ items: s.array(s.object({ column: s.string(), value: s.string().optional() })).max(100) }),
)
define(
  'feat.refine',
  s.string().refine((v) => v !== 'bad', 'not bad'),
)
define(
  'feat.refine.default.msg',
  s.string().refine((v) => v.length > 2),
)
define(
  'feat.refine.after.check',
  s
    .string()
    .min(3)
    .refine((v) => v !== 'bad', 'bad!'),
)
define(
  'feat.refine.skipped.on.type',
  s.object({ a: s.enum(['x']) }).refine(() => false, 'never'),
)
define(
  'feat.refine.runs.on.check',
  s.object({ a: s.string().max(2) }).refine(() => false, 'always'),
)
define(
  'feat.superRefine',
  s.object({ key: s.string().optional(), n: s.number().optional() }).superRefine((v, ctx) => {
    if (v.key && !v.key.includes('X')) ctx.addIssue({ code: 'custom', path: ['key'], message: 'needs X' })
  }),
)
define('feat.catch', s.number().int().min(1).optional().catch(undefined))
define('feat.catch.value', s.string().catch('fallback'))
define('feat.default.object', s.object({ port: s.number().int().min(1).max(65535).default(22) }))
define('feat.record.key.enum', s.object({ tags: s.record(s.string(), s.enum(['a', 'b'])).optional() }))

// The app's own schemas (the names are the ones in the snapshot script).
define('ssh.input', sshInputSchema)
define('ssh.optional', sshInputOptional)
define('v1.createConnectionBody', v1.createConnectionBody)
define('v1.patchConnectionBody', v1.patchConnectionBody)
define('v1.queryBody', v1.queryBody)
define('auth.passwordReset', auth.passwordReset)
const authSchemas = validators.authValidators()
define('auth.credentials', authSchemas.credentials)
define('auth.passwordChange', authSchemas.passwordChange)
define('v1.tokenBody', validators.tokenValidators().createToken)
const conn = validators.connectionValidators()
const activity = validators.activityValidators()
const saved = validators.savedQueryValidators()
const explorer = validators.explorerValidators()
define('fn.connectionInput', conn.connectionInput)
define('fn.connectionIdInput', conn.connectionId)
define('fn.updateConnectionInput', conn.updateConnection)
define('fn.testConnectionInput', conn.testConnection)
define('fn.listActivityInput', activity.listActivity)
define('fn.signalBackendInput', activity.signalBackend)
define('fn.schemaDiagramInput', validators.diagramValidators().schemaDiagram)
define('fn.listSavedQueriesInput', saved.listSavedQueries)
define('fn.createSavedQueryInput', saved.createSavedQuery)
define('fn.updateSavedQueryInput', saved.updateSavedQuery)
define('fn.deleteSavedQueryInput', saved.deleteSavedQuery)
define('fn.targetInput', explorer.target)
define('fn.connectionOnlyInput', explorer.connectionOnly)
define('fn.schemaObjectsInput', explorer.schemaObjects)
define('fn.relationInput', explorer.relation)
define('fn.objectDefinitionInput', explorer.objectDefinition)
define('fn.rowsRequest', explorer.rowsRequest)
define('fn.countRowsInput', explorer.countRows)
define('fn.applyChangesInput', explorer.applyChanges)
define('fn.lookupReferencesInput', explorer.lookupReferences)
define('fn.referenceLabelsInput', explorer.referenceLabels)
define('fn.executeSqlInput', explorer.executeSql)
define('fn.cancelSqlInput', explorer.cancelSql)

describe('compatibility with the recorded fixture', () => {
  for (const [name, entry] of Object.entries(FIXTURE.schemas)) {
    const ours = registry[name]
    test(`${name}: is covered by a schema`, () => {
      expect(ours).toBeDefined()
    })
    if (!ours) continue
    test(`${name}: JSON Schema matches`, () => {
      const json = JSON.parse(JSON.stringify(toJSONSchema(ours))) as unknown
      expect(json).toStrictEqual(entry.json)
    })
    test(`${name}: parse results match on ${entry.cases.length} inputs`, () => {
      for (const c of entry.cases) {
        const input = revive(c.input)
        const got = ours.safeParse(input) as { success: boolean; data?: unknown; error?: SchemaError }
        const label = JSON.stringify(c.input)
        if (c.ok) {
          expect({ label, ok: got.success }).toEqual({ label, ok: true })
          expect({ label, value: got.data }).toStrictEqual({ label, value: revive(c.value) })
        } else {
          expect({ label, ok: got.success }).toEqual({ label, ok: false })
          expect({ label, issues: got.error?.issues }).toStrictEqual({ label, issues: c.issues })
        }
      }
    })
  }
})

describe('compatibility of the parse functions that use schemas', () => {
  for (const c of FIXTURE.configCases) {
    test(`config file: ${c.name}`, () => {
      const run = () => parseConfigText(c.text, c.file)
      if (c.ok) expect(run()).toStrictEqual(revive(c.value) as ReturnType<typeof run>)
      else expect(() => run()).toThrow(new Error(c.error))
    })
  }
  for (const c of FIXTURE.importCases) {
    test(`CSV import mapping: ${c.query.slice(0, 60)}`, () => {
      const run = () => parseImportParams(new URLSearchParams(c.query))
      if (c.ok) expect(run()).toStrictEqual(revive(c.value) as ReturnType<typeof run>)
      else expect(() => run()).toThrow(new Error(c.error))
    })
  }
  for (const c of FIXTURE.exportCases) {
    test(`table export request: ${c.query.slice(0, 60)}`, () => {
      const run = () => parseTableExportRequest(new Request(`http://localhost/api/export?${c.query}`))
      if (c.ok) expect(run()).toStrictEqual(revive(c.value) as ReturnType<typeof run>)
      else expect(() => run()).toThrow(new Error(c.error))
    })
  }
})

// ---------------------------------------------------------------------------
// Unit tests for each feature
// ---------------------------------------------------------------------------

describe('primitive types', () => {
  test('string accepts strings only', () => {
    expect(s.string().parse('x')).toBe('x')
    expect(s.string().safeParse(1).success).toBe(false)
    expect(s.string().safeParse(null).success).toBe(false)
  })

  test('number rejects NaN and the infinities, with their messages', () => {
    expect(s.number().parse(1.5)).toBe(1.5)
    expect(s.number().safeParse(NaN)).toMatchObject({
      success: false,
      error: { issues: [{ message: 'Invalid input: expected number, received NaN' }] },
    })
    expect(s.number().safeParse(Infinity)).toMatchObject({
      success: false,
      error: { issues: [{ message: 'Invalid input: expected number, received Infinity' }] },
    })
    expect(s.number().safeParse('1').success).toBe(false)
  })

  test('boolean and null', () => {
    expect(s.boolean().parse(false)).toBe(false)
    expect(s.boolean().safeParse('false').success).toBe(false)
    expect(s.null().parse(null)).toBeNull()
    expect(s.null().safeParse(undefined).success).toBe(false)
  })

  test('unknown accepts anything', () => {
    expect(s.unknown().parse(undefined)).toBeUndefined()
    expect(s.unknown().parse({ a: 1 })).toEqual({ a: 1 })
  })

  test('literal and enum report the expected values', () => {
    expect(s.literal('all').safeParse('x')).toMatchObject({
      error: { issues: [{ code: 'invalid_value', message: 'Invalid input: expected "all"' }] },
    })
    expect(s.enum(['a']).safeParse('b')).toMatchObject({
      error: { issues: [{ message: 'Invalid input: expected "a"' }] },
    })
    expect(s.enum(['disable', 'require']).safeParse('x')).toMatchObject({
      error: { issues: [{ code: 'invalid_value', message: 'Invalid option: expected one of "disable"|"require"' }] },
    })
    expect(s.enum(['a', 'b']).parse('b')).toBe('b')
  })
})

describe('string checks', () => {
  test('trim runs before length checks', () => {
    expect(s.string().trim().min(2).parse(' ab ')).toBe('ab')
    expect(s.string().trim().min(1).safeParse('   ').success).toBe(false)
  })

  test('length checks count code points, not UTF-16 units', () => {
    expect(s.string().max(2).parse('😀😀')).toBe('😀😀')
    expect(s.string().min(2).safeParse('😀').success).toBe(false)
  })

  test('min and max messages use the usual wording, and custom messages replace them', () => {
    expect(s.string().min(3).safeParse('ab').error?.issues[0]?.message).toBe(
      'Too small: expected string to have >=3 characters',
    )
    expect(s.string().max(3).safeParse('abcd').error?.issues[0]?.message).toBe(
      'Too big: expected string to have <=3 characters',
    )
    expect(s.string().min(1, 'Name is required.').safeParse('').error?.issues[0]?.message).toBe('Name is required.')
  })

  test('regex: default and custom message', () => {
    expect(s.string().regex(/^a+$/).safeParse('b').error?.issues[0]).toEqual({
      code: 'invalid_format',
      path: [],
      message: 'Invalid string: must match pattern /^a+$/',
    })
    expect(s.string().regex(/^a+$/, 'nope').safeParse('b').error?.issues[0]?.message).toBe('nope')
  })

  test('a regex can be reused across parses (no stateful lastIndex)', () => {
    const schema = s.string().regex(/^a+$/g)
    expect(schema.parse('aa')).toBe('aa')
    expect(schema.parse('aa')).toBe('aa')
  })
})

describe('number checks', () => {
  test('int, positive, min and max', () => {
    expect(s.number().int().parse(3)).toBe(3)
    expect(s.number().int().safeParse(1.5).error?.issues[0]?.message).toBe(
      'Invalid input: expected int, received number',
    )
    expect(s.number().int().positive().safeParse(0).error?.issues[0]?.message).toBe(
      'Too small: expected number to be >0',
    )
    expect(s.number().min(1).safeParse(0).error?.issues[0]?.message).toBe('Too small: expected number to be >=1')
    expect(s.number().max(10).safeParse(11).error?.issues[0]?.message).toBe('Too big: expected number to be <=10')
  })

  test('a non-integer aborts the checks after int', () => {
    const issues = s
      .number()
      .int()
      .min(2)
      .safeParse(1.5)
      .error?.issues.map((i) => i.code)
    expect(issues).toEqual(['invalid_type'])
  })

  test('an integer outside the safe range is a bound on int', () => {
    expect(
      s
        .number()
        .int()
        .safeParse(2 ** 53).error?.issues[0],
    ).toEqual({
      code: 'too_big',
      path: [],
      message: 'Too big: expected int to be <=9007199254740991',
    })
    expect(
      s
        .number()
        .int()
        .safeParse(-(2 ** 53)).error?.issues[0]?.message,
    ).toBe('Too small: expected int to be >=-9007199254740991')
  })
})

describe('defaults, optional, nullable, catch', () => {
  test('default applies to undefined only and is not validated', () => {
    expect(s.number().int().min(1).default(22).parse(undefined)).toBe(22)
    expect(s.string().min(3).default('zz').parse(undefined)).toBe('zz')
    expect(s.string().min(3).default('zz').safeParse('a').success).toBe(false)
  })

  test('a default array is a fresh copy for each parse', () => {
    const schema = s.array(s.string()).default([])
    const first = schema.parse(undefined)
    first.push('x')
    expect(schema.parse(undefined)).toEqual([])
  })

  test('optional accepts undefined; nullable accepts null', () => {
    expect(s.string().optional().parse(undefined)).toBeUndefined()
    expect(s.string().nullable().parse(null)).toBeNull()
    expect(s.string().optional().safeParse(null).success).toBe(false)
    expect(s.string().nullable().safeParse(undefined).success).toBe(false)
  })

  test('catch replaces any failure with its value', () => {
    expect(s.number().catch(7).parse('x')).toBe(7)
    expect(s.string().min(3).catch('x').parse('a')).toBe('x')
    expect(s.number().int().min(1).optional().catch(undefined).parse('x')).toBeUndefined()
  })
})

describe('arrays, records and unions', () => {
  test('array checks the length and reports items by index', () => {
    expect(s.array(s.number()).min(1).safeParse([]).error?.issues[0]?.message).toBe(
      'Too small: expected array to have >=1 items',
    )
    expect(s.array(s.number()).safeParse([1, 'x']).error?.issues[0]?.path).toEqual([1])
  })

  test('record of string keys', () => {
    const schema = s.record(s.string(), s.union([s.string(), s.null()]))
    expect(schema.parse({ a: 'x', b: null })).toEqual({ a: 'x', b: null })
    expect(schema.safeParse([]).error?.issues[0]?.message).toBe('Invalid input: expected record, received array')
    expect(schema.safeParse({ a: 1 }).error?.issues[0]).toEqual({
      code: 'invalid_union',
      path: ['a'],
      message: 'Invalid input',
    })
  })

  test('union tries the options in order and returns the first that passes', () => {
    const schema = s.union([s.literal('all'), s.array(s.string()).min(1)])
    expect(schema.parse('all')).toBe('all')
    expect(schema.parse(['a'])).toEqual(['a'])
  })

  test('a union returns the issues of the one option that got past its type check', () => {
    const issue = s.union([s.literal('all'), s.array(s.string()).min(1)]).safeParse([]).error?.issues[0]
    expect(issue).toEqual({ code: 'too_small', path: [], message: 'Too small: expected array to have >=1 items' })
    expect(s.union([s.literal('all'), s.array(s.string())]).safeParse('x').error?.issues).toEqual([
      { code: 'invalid_union', path: [], message: 'Invalid input' },
    ])
  })
})

describe('objects', () => {
  test('unknown keys are stripped by object and rejected by strictObject', () => {
    expect(s.object({ a: s.string() }).parse({ a: 'x', b: 1 })).toEqual({ a: 'x' })
    expect(s.strictObject({ a: s.string() }).safeParse({ a: 'x', b: 1 }).error?.issues[0]).toEqual({
      code: 'unrecognized_keys',
      path: [],
      message: 'Unrecognized key: "b"',
    })
    expect(s.strictObject({ a: s.string() }).safeParse({ a: 'x', b: 1, c: 2 }).error?.issues[0]?.message).toBe(
      'Unrecognized keys: "b", "c"',
    )
  })

  test('every field problem is reported, in shape order', () => {
    const issues = s.object({ a: s.string(), b: s.number() }).safeParse({ b: 'x' }).error?.issues
    expect(issues).toEqual([
      { code: 'invalid_type', path: ['a'], message: 'Invalid input: expected string, received undefined' },
      { code: 'invalid_type', path: ['b'], message: 'Invalid input: expected number, received string' },
    ])
  })

  test('defaults fill absent keys, optional keys stay absent, present undefined keys stay present', () => {
    const schema = s.object({ a: s.string().optional(), b: s.number().default(1) })
    expect(schema.parse({})).toStrictEqual({ b: 1 })
    expect(schema.parse({ a: undefined, b: 2 })).toStrictEqual({ a: undefined, b: 2 })
  })

  test('a non-object input is rejected with its message', () => {
    expect(s.object({}).safeParse(null).error?.issues[0]?.message).toBe('Invalid input: expected object, received null')
    expect(s.object({}).safeParse([]).error?.issues[0]?.message).toBe('Invalid input: expected object, received array')
  })

  test('extend and pick', () => {
    const base = s.object({ id: s.string(), name: s.string(), n: s.number() })
    expect(base.extend({ extra: s.boolean() }).parse({ id: 'a', name: 'b', n: 1, extra: true })).toEqual({
      id: 'a',
      name: 'b',
      n: 1,
      extra: true,
    })
    expect(base.pick({ id: true }).parse({ id: 'a' })).toEqual({ id: 'a' })
  })

  test('object refinements run only when the fields passed their type checks', () => {
    const schema = s.object({ a: s.enum(['x']) }).refine(() => false, 'never')
    expect(schema.safeParse({ a: 'y' }).error?.issues.map((i) => i.code)).toEqual(['invalid_value'])
    expect(schema.safeParse({ a: 'x' }).error?.issues[0]?.message).toBe('never')
  })

  test('superRefine adds issues at a path', () => {
    const schema = s.object({ key: s.string() }).superRefine((v, ctx) => {
      if (!v.key.includes('X')) ctx.addIssue({ code: 'custom', path: ['key'], message: 'needs X' })
    })
    expect(schema.safeParse({ key: 'a' }).error?.issues[0]).toEqual({
      code: 'custom',
      path: ['key'],
      message: 'needs X',
    })
    expect(schema.parse({ key: 'aX' })).toEqual({ key: 'aX' })
  })
})

describe('parse, safeParse and Standard Schema', () => {
  test('parse throws a SchemaError whose message lists the issues', () => {
    const schema = s.object({ port: s.number().int() })
    let caught: unknown
    try {
      schema.parse({ port: 'x' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SchemaError)
    expect((caught as Error).message).toBe('port: Invalid input: expected number, received string')
  })

  test('the root path is shown as (root)', () => {
    expect(() => s.object({}).parse(undefined)).toThrow('(root): Invalid input: expected object, received undefined')
  })

  test('the Standard Schema interface validates and reports issues with messages and paths', () => {
    const schema = s.object({ a: s.string().min(2) })
    const std = schema['~standard']
    expect(std.version).toBe(1)
    expect(std.validate({ a: 'xy' })).toEqual({ value: { a: 'xy' } })
    const failed = std.validate({ a: 'x' }) as { issues: Array<{ code: string; message: string; path?: unknown[] }> }
    expect(failed.issues).toEqual([
      { code: 'too_small', path: ['a'], message: 'Too small: expected string to have >=2 characters' },
    ])
  })

  test('inference types the output and the input', () => {
    const schema = s.object({ name: s.string().trim(), port: s.number().int().default(22), tag: s.string().optional() })
    type Out = Infer<typeof schema>
    type In = InferInput<typeof schema>
    const out: Out = { name: 'x', port: 1 }
    const input: In = { name: 'x' }
    expect(out.port).toBe(1)
    expect(input.name).toBe('x')
  })
})
