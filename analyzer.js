import { assertTrue, MutableSets, MutableMaps } from 'common';
import { Atom, Neg, App } from './rsp.js';

function topoSort(predicates)
{

  const sccs = [];

  let index = 0;
  const S = [];

  for (const v of predicates)
  {
    if (v.index === undefined)
    {
      strongconnect(v);
    }
  } 

  function strongconnect(v)
  {
    v.index = index;
    v.lowlink = index;
    index++;
    S.push(v);
    v.onStack = true;

    for (const w of v.precedes)
    {
      if (w.index === undefined)
      {
        strongconnect(w);
        v.lowlink = Math.min(v.lowlink, w.lowlink);
      }
      else if (w.onStack)
      {
        v.lowlink = Math.min(v.lowlink, w.index);
      }
    }
    
    if (v.lowlink === v.index)
    {
      const scc = [];
      let w;
      do
      {
        w = S.pop();
        w.onStack = false;
        scc.push(w);
      }
      while (w !== v)
      sccs.push(scc);
    }
  }
  const rsccs = sccs.reverse();
  return rsccs;
}
 
class Pred
{
  constructor(name, arity)
  {
    this.name = name;
    this.arity = arity;
    this.edb = true;
    this.idb = false;
    this.rules = new Set();
    this.posDependsOn = new Set();
    this.negDependsOn = new Set();
    this.posAppearsIn = new Set();
    this.negAppearsIn = new Set();
    this.precedes = new Set();
}

  toString()
  {
    return this.name;
  }
}

class Functor
{
  constructor(name, arity)
  {
    this.name = name;
    this.arity = arity;
  }
  
  toString()
  {
    return this.name;
  }
}

function collect(program)
{

  const name2pred = new Map();
  const name2functor = new Map();

  function handleFunctor(functor)
  {
    const name = functor.pred;
    const arity = functor.arity();
    let func = name2functor.get(name);
    if (func === undefined)
    {
      func = new Functor(name, arity);
      name2functor.set(name, func);
      return func;
    }
    if (func.arity !== arity)
    {
      throw new Error(`arity mismatch for functor ${func}`);
    }

    // scan exps
    for (const exp of func.terms)
    {
      if (exp instanceof Atom)
      {
        // atom exp in functor = functor
        handleFunctor(exp);
      }
    }
  }

  function handleAtom(atom, rule)
  {
    const name = atom.pred;
    const arity = atom.arity();
    let pred = name2pred.get(name);
    if (pred === undefined)
    {
      pred = new Pred(name, arity);
      name2pred.set(name, pred);
      return pred;
    }
    if (pred.arity !== arity)
    {
      throw new Error(`arity mismatch for atom ${atom} in rule ${rule}: expected arity ${pred.arity}, got ${arity}`);
    }

    // scan exps
    for (const exp of atom.terms)
    {
      if (exp instanceof Atom)
      {
        // atom exp in atom = functor
        handleFunctor(exp);
      }
    }
    return pred;
  }

  for (const rule of program.rules)
  {
    const head = rule.head;
    const headPred = handleAtom(head, rule);
    headPred.idb = true;
    headPred.edb = false;
    headPred.rules.add(rule);
    for (const queryPart of rule.body)
    {
      if (queryPart instanceof Atom)
      {
        const pred = handleAtom(queryPart, rule);
        pred.precedes.add(headPred);
        headPred.posDependsOn.add(pred);
        pred.posAppearsIn.add(rule);
      }
      else if (queryPart instanceof Neg)
      {
        const atom = queryPart.atom;
        const pred = handleAtom(atom);
        pred.precedes.add(headPred, rule);
        headPred.negDependsOn.add(pred);
        pred.negAppearsIn.add(rule);
      }
      else if (queryPart instanceof App)
      {
        // ignore
      }
      else
      {
        throw new Error(`cannot handle ${queryPart} of type ${queryPart.constructor.name} in ${rule}`);
      }
    }
  }

  return { name2pred, name2functor };
}

class Stratum
{
  constructor(id, preds)
  {
    this.id = id;
    this.preds = preds;
    this.nonRecursiveRules = new Set();    
    this.recursiveRules = new Set();

    // pred -> [{rule, atompos}]
    this.pred2negDeps = new Map();

    this.posDependsOn = new Set(); // derived from this.preds
    this.negDependsOn = new Set(); // derived from this.preds
  }
  isStratumPredName(predName)
  {
    for (const pred of this.preds)
    {
      if (pred.name === predName)
      {
        return true;
      }
    }
    return false;
  }
  toString()
  {
    return `{stratum id:${this.id} preds:${this.preds.join(",")}}`;
  }
}


function makeStratum(name2pred)
{

  function isStratumRecursiveRule(rule, scPreds)
  {
    for (const atom of rule.body)
    {
      if (atom instanceof Atom) // only pos deps can result in recursive rule
      {
        const bodyPred = name2pred.get(atom.pred);
        if (scPreds.includes(bodyPred))
        {
          return true;
        }  
      }
    }
    return false;
  }

  return function (scPreds, id)
  {
    const stratum = new Stratum(id, scPreds);
    for (const pred of scPreds)
    {
      pred.stratum = stratum;
      MutableSets.addAll(stratum.posDependsOn, pred.posDependsOn);
      MutableSets.addAll(stratum.negDependsOn, pred.negDependsOn);
      for (const rule of pred.rules)
      {
        if (isStratumRecursiveRule(rule, scPreds))
        {
          stratum.recursiveRules.add(rule);
        }
        else
        {
          stratum.nonRecursiveRules.add(rule);
        }

        for (let i = 0; i < rule.body.length; i++)
        {
          const b = rule.body[i];
          if (b instanceof Neg)
          {
            MutableMaps.putPushArray(stratum.pred2negDeps, b.atom.pred, {rule, i});
          }
        }
      }
    }
    return stratum;
  }
}

export function analyzeProgram(program)
{
  const { name2pred, name2functor } = collect(program);
  const predicates = [...name2pred.values()];
  const sccPreds = topoSort(predicates);
  const strata = sccPreds.map(makeStratum(name2pred));
  const preds = sccPreds.flat();

  const rule2stratum = new Map();
  strata.forEach(stratum =>
    {
      for (const rule of stratum.nonRecursiveRules)
      {
        rule2stratum.set(rule, stratum);
      }
      for (const rule of stratum.recursiveRules)
      {
        rule2stratum.set(rule, stratum);
      }
    });

  return { 
    program, name2pred, strata,
    preds,
    
    // new design (to be phased in): methods on this obj instead of methods/props on objects)
    functors()
    {
      return [...name2functor.values()];
    },

    // is there at least one rule that produces pred that is not recursive
    // (i.e., rule from from a lower stratum)
    // => `true` for local edb preds that are not also global edb (latter don't have producing rules)
    predHasNonRecursiveRule(pred)
    {
      for (const rule of pred.rules)
      {
        if (this.ruleIsNonRecursive(rule))
        {
          return true;
        }
      }
      return false;
    },

    predHasRecursiveRule(pred)
    {
      for (const rule of pred.rules)
      {
        if (this.ruleIsRecursive(rule))
        {
          return true;
        }
      }
      return false;
    },

    // is pred created by agg rule? (condition: has exactly one agg rule to avoid complex/impossible semantics with groupbys)
    predIsAggregating(pred)
    {
      if (pred.rules.size === 1)
      {
        const aggregates = [...pred.rules][0].aggregates();
        return aggregates;
      }
      return false;
    },

    ruleIsNonRecursive(rule)
    {
      const stratum = rule2stratum.get(rule);
      return stratum.nonRecursiveRules.has(rule);
    },

    ruleIsRecursive(rule)
    {
      const stratum = rule2stratum.get(rule);
      return stratum.recursiveRules.has(rule);
    },

    stratumHasRecursiveRule(stratum)
    {
      return stratum.recursiveRules.size > 0;
    }
  };
}