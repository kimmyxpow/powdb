// The CodeMirror implementation. Only loaded through React.lazy from ./codemirror.tsx,
// so the packages below stay out of the entry and route chunks until an editor is shown.
import {
  acceptCompletion,
  autocompletion as completionExt,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers as lineNumberGutter,
  placeholder as placeholderExt,
  rectangularSelection,
} from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import {
  forwardRef,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { shortcut } from '@/hooks/use-hotkey'
import { statementAt } from '@/lib/sql'
import { cn } from '@/lib/utils'
import type { SqlCodeViewProps, SqlEditorHandle, SqlEditorProps } from './codemirror'

const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--foreground)',
    padding: '10px 0',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '1.5px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--syntax-selection) !important' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'color-mix(in srgb, var(--muted-foreground) 55%, transparent)',
    border: 'none',
    paddingLeft: '6px',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', paddingRight: '10px' },
  '.cm-activeLine': { backgroundColor: 'var(--grid-row-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--muted)',
    border: 'none',
    color: 'var(--muted-foreground)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--syntax-selection)',
    outline: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    boxShadow: '0 8px 24px -8px rgb(0 0 0 / 0.18)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    padding: '4px',
    maxHeight: '16rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    borderRadius: '6px',
    padding: '3px 8px',
    lineHeight: '1.5',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  '.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-placeholder': { color: 'color-mix(in srgb, var(--muted-foreground) 70%, transparent)', fontStyle: 'normal' },
  '.cm-error-range': {
    textDecoration: 'underline wavy var(--destructive)',
    textUnderlineOffset: '3px',
    backgroundColor: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
  },
})

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syntax-keyword)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syntax-number)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.standard(t.name), color: 'var(--syntax-function)' },
  { tag: t.typeName, color: 'var(--syntax-type)' },
  { tag: [t.operator, t.punctuation, t.paren, t.brace, t.squareBracket], color: 'var(--syntax-operator)' },
  { tag: t.special(t.name), color: 'var(--syntax-number)' },
])

const sqlHighlighting: Extension = syntaxHighlighting(highlight)

// --- error highlight -------------------------------------------------------

const setErrorRange = StateEffect.define<{ from: number; to: number } | null>()
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setErrorRange)) {
        value =
          e.value && e.value.to > e.value.from
            ? Decoration.set([Decoration.mark({ class: 'cm-error-range' }).range(e.value.from, e.value.to)])
            : Decoration.none
      }
    }
    if (tr.docChanged) return Decoration.none
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

// --- generic editor --------------------------------------------------------

/** Set on transactions that replace the doc from the `value` prop, so onChange is not fired for them. */
const ExternalChange = Annotation.define<boolean>()

interface CodeMirrorRef {
  readonly view: EditorView | null
}

interface CodeMirrorProps {
  value: string
  onChange?: (value: string) => void
  extensions?: Extension[]
  editable?: boolean
  readOnly?: boolean
  placeholder?: string
  /** Initial-only: the active line highlight and autocompletion are set when the view is created. */
  activeLine?: boolean
  completion?: boolean
  maxHeight?: string
  autoFocus?: boolean
  className?: string
  /** Key commands of the SQL editor. Initial-only: the key bindings are made when the view is created. */
  commands?: { onRun: () => void; onRunStatement: () => void; onFormat: () => void }
}

const NO_EXTENSIONS: Extension[] = []

/** The ref handle reads `view` on access, so it always reports the current view (a getter, built outside the component). */
function viewHandle(viewRef: { readonly current: EditorView | null }): CodeMirrorRef {
  return {
    get view() {
      return viewRef.current
    },
  }
}

function maxHeightTheme(maxHeight?: string): Extension {
  return maxHeight ? EditorView.theme({ '&': { maxHeight } }) : []
}

function editableExtensions(editable: boolean, readOnly: boolean): Extension[] {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(readOnly)]
}

function placeholderExtension(text: string): Extension {
  return text ? placeholderExt(text) : []
}

function baseExtensions(opts: { activeLine: boolean; completion: boolean }): Extension[] {
  return [
    lineNumberGutter(),
    opts.activeLine ? [highlightActiveLine(), highlightActiveLineGutter()] : [],
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    opts.completion ? completionExt() : [],
    rectangularSelection(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...(opts.completion ? completionKeymap : []),
      indentWithTab,
    ]),
  ]
}

const CodeMirrorEditor = forwardRef<CodeMirrorRef, CodeMirrorProps>(function CodeMirrorEditor(
  {
    value,
    onChange,
    extensions = NO_EXTENSIONS,
    editable = true,
    readOnly = false,
    placeholder = '',
    activeLine = true,
    completion = true,
    maxHeight,
    autoFocus,
    className,
    commands,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Effect events: the editor's listener and key bindings are made once with the view,
  // but must always reach the latest onChange and command handlers.
  const notifyChange = useEffectEvent((doc: string) => onChange?.(doc))
  const runCommand = useEffectEvent((command: 'onRun' | 'onRunStatement' | 'onFormat') => commands?.[command]())

  // Compartments are created once, so prop changes reconfigure the existing view.
  const [parts] = useState(() => ({
    extensions: new Compartment(),
    editable: new Compartment(),
    placeholder: new Compartment(),
    maxHeight: new Compartment(),
  }))

  // the props last applied to the view, so the reconfigure effect only dispatches what changed
  const applied = useRef({ extensions, editable, readOnly, placeholder, maxHeight })

  // The view is created once; this effect event reads the props as of the latest render.
  const createView = useEffectEvent(() => {
    const view = new EditorView({
      parent: containerRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (update.transactions.some((tr) => tr.annotation(ExternalChange))) return
            notifyChange(update.state.doc.toString())
          }),
          parts.maxHeight.of(maxHeightTheme(maxHeight)),
          baseExtensions({ activeLine, completion }),
          editorTheme,
          parts.editable.of(editableExtensions(editable, readOnly)),
          parts.placeholder.of(placeholderExtension(placeholder)),
          parts.extensions.of(extensions),
          commands
            ? Prec.highest(
                keymap.of([
                  {
                    key: 'Mod-Enter',
                    run: () => {
                      runCommand('onRun')
                      return true
                    },
                  },
                  {
                    key: 'Shift-Mod-Enter',
                    run: () => {
                      runCommand('onRunStatement')
                      return true
                    },
                  },
                  {
                    key: 'Shift-Alt-f',
                    run: () => {
                      runCommand('onFormat')
                      return true
                    },
                  },
                  { key: 'Tab', run: acceptCompletion },
                ]),
              )
            : [],
        ],
      }),
    })
    viewRef.current = view
    if (autoFocus) view.focus()
    return view
  })

  useLayoutEffect(() => {
    const view = createView()
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [parts])

  useEffect(() => {
    const view = viewRef.current
    const prev = applied.current
    applied.current = { extensions, editable, readOnly, placeholder, maxHeight }
    if (!view) return
    const effects: StateEffect<unknown>[] = []
    if (prev.extensions !== extensions) effects.push(parts.extensions.reconfigure(extensions))
    if (prev.editable !== editable || prev.readOnly !== readOnly) {
      effects.push(parts.editable.reconfigure(editableExtensions(editable, readOnly)))
    }
    if (prev.placeholder !== placeholder) {
      effects.push(parts.placeholder.reconfigure(placeholderExtension(placeholder)))
    }
    if (prev.maxHeight !== maxHeight) effects.push(parts.maxHeight.reconfigure(maxHeightTheme(maxHeight)))
    if (effects.length) view.dispatch({ effects })
  }, [extensions, editable, readOnly, placeholder, maxHeight, parts])

  // controlled value: replace the doc when the prop differs, without firing onChange
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: ExternalChange.of(true),
    })
  }, [value])

  useImperativeHandle(ref, () => viewHandle(viewRef), [])

  return <div className={className} ref={containerRef} />
})

// --- editable editor ------------------------------------------------------

export const SqlEditorCore = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, onChange, schema, defaultSchema, onRun, onRunStatement, onFormat, autoFocus },
  ref,
) {
  const cm = useRef<CodeMirrorRef>(null)

  useImperativeHandle(ref, () => ({
    getRunText: () => {
      const view = cm.current?.view
      if (!view) return { text: value, offset: 0, isSelection: false }
      const sel = view.state.selection.main
      if (!sel.empty) {
        return { text: view.state.sliceDoc(sel.from, sel.to), offset: sel.from, isSelection: true }
      }
      return { text: view.state.doc.toString(), offset: 0, isSelection: false }
    },
    getStatementAtCursor: () => {
      const view = cm.current?.view
      if (!view) return null
      return statementAt(view.state.doc.toString(), view.state.selection.main.head)
    },
    setValue: (next: string) => {
      const view = cm.current?.view
      if (!view) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    },
    focus: () => cm.current?.view?.focus(),
    showError: (range) => {
      const view = cm.current?.view
      if (!view) return
      const len = view.state.doc.length
      const r = range ? { from: Math.min(range.from, len), to: Math.min(range.to, len) } : null
      view.dispatch({
        effects: setErrorRange.of(r),
        ...(r ? { selection: { anchor: r.from }, scrollIntoView: true } : {}),
      })
    },
  }))

  const extensions = useMemo(
    () => [
      sql({
        dialect: PostgreSQL,
        schema,
        defaultSchema,
        upperCaseKeywords: true,
      }),
      sqlHighlighting,
      errorField,
      EditorView.lineWrapping,
    ],
    [schema, defaultSchema],
  )

  return (
    <CodeMirrorEditor
      autoFocus={autoFocus}
      className="h-full min-h-0"
      commands={{ onRun, onRunStatement, onFormat }}
      extensions={extensions}
      onChange={onChange}
      placeholder={`Write SQL here, e.g. SELECT * FROM …, then press ${shortcut('Enter')} to run it`}
      ref={cm}
      value={value}
    />
  )
})

// --- read-only viewer ------------------------------------------------------

const viewerExtensions: Extension[] = [sql({ dialect: PostgreSQL }), sqlHighlighting, EditorView.lineWrapping]

export function SqlCodeViewCore({ value, className, maxHeight }: SqlCodeViewProps) {
  const cm = useRef<CodeMirrorRef>(null)
  useEffect(() => {
    cm.current?.view?.scrollDOM.scrollTo({ top: 0 })
  }, [value])
  return (
    <CodeMirrorEditor
      activeLine={false}
      className={cn('min-h-0', className)}
      completion={false}
      editable={false}
      extensions={viewerExtensions}
      maxHeight={maxHeight}
      readOnly
      ref={cm}
      value={value}
    />
  )
}
