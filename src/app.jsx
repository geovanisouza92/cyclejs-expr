import { div, input, button, label } from '@cycle/dom'
import Collection from '@cycle/collection'
import xs from 'xstream'
import debounce from 'xstream/extra/debounce'
import dropRepeats from 'xstream/extra/dropRepeats'
import pairwise from 'xstream/extra/pairwise'
import delay from 'xstream/extra/delay'
import concat from 'xstream/extra/concat'
import * as R from 'ramda'
import * as math from 'mathjs'

// Warn formula errors on console
const warn = console.warn.bind(console)

// Restrict a Stream to only emit unique values
const uniq = dropRepeats(R.equals)

// Check if a name is not reserved for math.js
const notReserved = R.complement(R.has(R.__, math))

// Parse formula text into a structure
function parseFormula(text) {
  const parsed = math.parse(text)
  const expr = parsed.compile()
  var vars = []
  parsed.traverse((n, _, p) => {
    if (n.isSymbolNode && notReserved(n.name)) {
      vars.push(n.name)
    }
  })
  return { text, expr, vars, ok: true }
}

// Signal a value for invalid formulas
const parseError = R.compose(R.always({ ok: false }), warn)

// Signal undefined values for missing scope variables
const undefined$ = xs.create().startWith(undefined)

// Given a parent scope with variables of streams,
// restrict it to only the required variables,
// returning an scope with streams values
function lensScope(vars) {
  return function (scope$) {
    return scope$
      .map(R.props(vars))
      .map(
      R.ap([
        R.when(
          R.equals(undefined),
          R.always(undefined$)
        )
      ])
      )
      .map(R.apply(xs.combine))
      .flatten()
      .map(R.zipObj(vars))
      .compose(uniq)
  }
}

// Get formula text
const formulaText = R.prop('text')

// Item represents a tuple name-formula, with associated
// value computed from parent's scope
function Item(sources) {
  //
  // Intent
  //
  const removeClick$ = sources.DOM
    .select('.remove').events('click')
  const nameChanges$ = sources.DOM
    .select('.name').events('input')
    .compose(debounce(250))
    .map(ev => ev.target.value)
    .filter(name => !R.isEmpty(name) && notReserved(name))
  const formulaChanges$ = sources.DOM
    .select('.formula').events('input')
    .compose(debounce(250))
    .map(ev => ev.target.value)
  // .debug('formulaChanges$')
  const formulaFocus$ = sources.DOM
    .select('.formula').events('focus')
    .mapTo(true)
  const formulaBlur$ = sources.DOM
    .select('.formula').events('blur')
    .mapTo(false)
  //
  // Model
  //
  const name$ = xs.merge(
    // Load from storage
    sources.initial$.map(R.prop('name')),
    nameChanges$
  )
    .compose(uniq)
    .remember()
  // Signal a variable rename
  const rename$ = name$.compose(pairwise)
  const formula$ = xs.merge(
    // Load from storage
    sources.initial$.map(R.prop('formula')),
    formulaChanges$
  )
    .compose(uniq)
    .map(R.tryCatch(parseFormula, parseError))
    .filter(f => f.ok)
    .remember()
  const value$ = formula$
    .map(f => sources.scope$
      .compose(lensScope(f.vars))
      // Evaluate the formula against the scope
      .map(
      R.tryCatch(
        scope => f.expr.eval(scope),
        R.compose(R.always(undefined), warn)
      )
      )
      .compose(uniq)
    )
    .flatten()
    .remember()
  // Publish to parent the name, formula and value
  // stream (for quick wiring)
  const target$ = xs.combine(name$, formula$.map(formulaText))
    .map(([name, formula]) => ({ name, formula, value$ }))
  // Signal a variable removal
  const remove$ = xs.merge(
    // Load from storage
    sources.initial$.map(R.prop('name')),
    nameChanges$
  )
    // TODO: Could this be avoided?
    .startWith('')
    .map(name => removeClick$.mapTo(name))
    .flatten()
  //
  // View
  //
  const vtree$ = xs.combine(
    name$.startWith(''),
    formula$.map(formulaText).startWith(''),
    value$.startWith(undefined)
  )
    .map(([name, formula, value]) =>
      div('.item', [
        button('.remove', 'Remove'),
        input('.name', { attrs: { value: name } }),
        input('.formula', { attrs: { value: formula } }),
        label(` = ${value || ''}`)
      ])
    )
  const sinks = {
    DOM: vtree$,
    target$,
    rename$,
    remove$
  }
  return sinks
}

// Adjust the values saved on localStorage to valid
// initial streams for child Item's
// TODO: Rewrite comment here
function asCollection(fromStorage$) {
  return fromStorage$
    .map(
    R.converge(
      R.zipWith((k, v) => xs.of({ name: k, formula: v })),
      [
        R.keys,
        R.values
      ]
    )
    )
    .map(xs.fromArray)
    .flatten()
    .map(initial$ => ({ initial$ }))
    // FIXME: Removing this debug, raises "Maximum call stack size excedeed"
    .debug('asCollection')
}

function List(sources) {
  //
  // Intent
  //
  const addClicks$ = sources.DOM
    .select('.add').events('click')
    .mapTo({ initial$: xs.never() })
  const targetProxy$ = xs.create()
  const formulaReducer$ = targetProxy$
    .map(target => R.set(R.lensProp(target.name), target.formula))
  const valueReducer$ = targetProxy$
    .map(target => R.set(R.lensProp(target.name), target.value$))
  const removeProxy$ = xs.create()
  const removeReducer$ = removeProxy$.map(R.omit)
  const storageReducer$ = xs.merge(
    formulaReducer$,
    removeReducer$
  )
  const scopeReducer$ = xs.merge(
    valueReducer$,
    removeReducer$
  )
  //
  // Model
  //
  // Load previously saved formula collection
  const fromStorage$ = sources.storage.local
    .getItem('formulas')
    .take(1)
    .map(value => value || '{}')
    .map(JSON.parse)
  // localStorage persistence requests
  const storage$ = fromStorage$
    .map(fromStorage => storageReducer$
      .fold((storage, reducer) => reducer(storage), fromStorage)
    )
    .flatten()
    .compose(uniq)
    .map(storage => {
      return {
        key: 'formulas',
        value: JSON.stringify(storage)
      }
    })
    .debug()
  const add$ = concat(fromStorage$.compose(asCollection), addClicks$)
  // Shared scope with child Item's
  const scope$ = scopeReducer$
    .fold((scope, reducer) => reducer(scope), {})
  // Child Item's
  const c = Collection(
    Item,
    R.set(R.lensProp('scope$'), scope$, sources),
    add$,
    item => item.remove$.compose(delay(100))
  )
  // Pipe Item's Events and Signals back to proxies
  // updating the scope and storage
  const target$ = Collection.merge(c, item => item.target$)
  targetProxy$.imitate(target$)
  const remove$ = Collection.merge(c, item => item.remove$)
  const rename$ = Collection.merge(c, item => item.rename$)
  removeProxy$.imitate(remove$)
  const items$ = Collection.pluck(c, item => item.DOM)
  //
  // View
  //
  const vtree$ = items$
    .map(items =>
      div('.list', [
        button('.add', 'Add'),
        div('.items', items)
      ])
    )
  const sinks = {
    // Declaration order affects the stream graph
    DOM: vtree$,
    storage: storage$
  }
  return sinks
}

export const App = List
