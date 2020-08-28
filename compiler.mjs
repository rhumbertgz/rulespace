import fs from 'fs';
import { assertTrue } from './common.mjs';
import { parseProgram, Var, Atom, Bin, Assign, Agg} from './parser.mjs';
import { analyzeProgram } from './analyzer.mjs';

export function compileFile(name)
{
  const compiled = compile(fs.readFileSync(`${name}.js`, 'utf8'));
  fs.writeFileSync(`${name}.mjs`, compiled, 'utf8');
}

export function compile(src)
{
  const program = parseProgram(src);

  const staticInfo = analyzeProgram(program);
  //console.log("topo: " + staticInfo.topoSorted);

  const sb = [];

  sb.push(emitImports);
  
  for (const [pred, arity] of staticInfo.pred2arity)
  {
    sb.push(emitTupleObjects(pred, arity));
  }

  staticInfo.rules.forEach((rule, i) =>
  {
    if (rule.aggregates())
    {
      sb.push(emitRuleGBObject(rule));
    }
    else
    {
      sb.push(emitRuleObject(rule));
    }
  });

  sb.push(emitIterators(staticInfo.predicates, staticInfo.rules));

  sb.push(emitEdbTuples(staticInfo.strata));
  sb.push(emitAddTuples(staticInfo.strata));
  
  sb.push(emitReset(staticInfo.predicates, staticInfo.rules));

  sb.push(emitRest);

  return sb.join('\n');
}


function emitTupleObjects(pred, arity)
{
  const termNames = Array.from(Array(arity), (_, i) => "t" + i);
  const termEqualities = termNames.map(t => `Object.is(member.${t}, ${t})`);
  const termAssignments = termNames.map(t => `this.${t} = ${t}`);
  const termToStrings = termNames.map(t => `this.${t}`);

  return `

  export function ${pred}(${termNames.join(', ')})
  {
    for (const member of ${pred}_.members)
    {
      if (${termEqualities.join(' && ')})
      {
        return member;
      }
    }
    return new ${pred}_(${termNames.join(', ')});
  }
  function ${pred}_(${termNames.join(', ')})
  {
    ${termAssignments.join('; ')};
    this._outproducts = new Set();
    this._outproductsgb = new Set();
    ${pred}_.members.add(this);
  }
  ${pred}_.members = new Set();
  ${pred}_.prototype.toString = function () {return atomString("${pred}", ${termToStrings.join(', ')})};  

  `;
}

function compileRuleFireBody(ruleName, head, body, i, compileEnv, ptuples)
{
  if (i === body.length)
  {
    const pred = head.pred;
    const t2ps = ptuples.map(tuple => `${tuple}._outproducts.add(product);`);
    return `
      // updates for ${head}
      const ptuples = new Set([${ptuples.join(', ')}]);
      const product = new Product(${ruleName}, ptuples);
      const resultTuple = ${pred}(${head.terms.join(', ')});
      if (product._outtuple !== resultTuple)
      {
        product._outtuple = resultTuple;
        ${t2ps.join('\n        ')}
        newTuples.add(resultTuple);
      }
    `;
  }


  const atom = body[i];

  if (atom instanceof Atom)
  {
    const tuple = "tuple" + i;
    ptuples.push(tuple);
    const pred = atom.pred;
    const bindUnboundVars = [];
    const conditions = [];
    atom.terms.forEach((term, i) => {
      if (term instanceof Var)
      {
        if (compileEnv.has(term.name))
        {
          conditions.push(`${tuple}.t${i} === ${term.name}`);
        }
        else
        {
          bindUnboundVars.push(`const ${term.name} = ${tuple}.t${i};`);
          compileEnv.add(term.name);
        }
      }
      else if (term instanceof Lit)
      {
        conditions.push(`${tuple}.t${i} === ${termToString(term.value)}`);
      }
      else
      {
        throw new Error();
      }
    });

    if (conditions.length === 0)
    {
      return `
      // atom ${atom} [no conditions]
      for (const ${tuple} of (deltaPos === ${i} ? deltaTuples : ${pred}_.members))
      {
        ${bindUnboundVars.join('\n        ')}
        ${compileRuleFireBody(ruleName, head, body, i+1, compileEnv, ptuples)}
      }
      `;  
    }
    else
    {
      return `
      // atom ${atom} [conditions]
      for (const ${tuple} of (deltaPos === ${i} ? deltaTuples : ${pred}_.members))
      {
        if (${conditions.join('&&')})
        {
          ${bindUnboundVars.join('\n       ')}
          ${compileRuleFireBody(ruleName, head, body, i+1, compileEnv, ptuples)}
        }
      }
      `;  
    }
  }

  if (atom instanceof Assign)
  {
    assertTrue(atom.operator === '='); // nothing else supported at the moment
    assertTrue(atom.left instanceof Var); // nothing else supported at the moment
    const name = atom.left.name;
    if (compileEnv.has(name))
    {
      throw new Error("assigning bound name: " + name);
    }
    compileEnv.add(name);
    const left = compileTerm(atom.left);
    const right = compileTerm(atom.right);
    return `
      // assign ${atom}
      const ${left} = ${right};

      ${compileRuleFireBody(ruleName, head, body, i+1, compileEnv, ptuples)}
    `;
  }

  throw new Error(body[i]);
}

// (Reachable x y) :- (Reachable x z) (Link z y)
function emitRuleObject(rule)
{
  const ruleName = "Rule" + rule._id;
  const compileEnv = new Set();

  return `
/* rule [no aggregates] 
${rule} 
*/
const ${ruleName} =
{
  name : '${ruleName}',

  fire(deltaPos, deltaTuples)
  {
    const newTuples = new Set();

    ${compileRuleFireBody(ruleName, rule.head, rule.body, 0, compileEnv, [])}

    return newTuples;
  }
} // end ${ruleName}

  `;
}



function compileRuleGBFireBody(ruleName, head, body, i, compileEnv, ptuples)
{
  if (i === body.length)
  {
    const agg = head.terms[head.terms.length - 1];
    assertTrue(agg instanceof Agg);
    const aggregand = agg.aggregand;
    const gb = head.terms.slice(0, head.terms.length - 1);
    return `
      // updates for ${head}
      const ptuples = new Set([${ptuples.join()}]);
      const productGB = new ProductGB(${ruleName}, ptuples, ${aggregand});
      const groupby = new ${ruleName}GB(${gb.join()});

      if (productGB._outgb === groupby) // 'not new': TODO turn this around
      {
        // already contributes, do nothing
      }
      else
      {
        const currentAdditionalValues = updates.get(groupby);
        if (!currentAdditionalValues)
        {
          updates.set(groupby, [${aggregand}]);
        }
        else
        {
          currentAdditionalValues.push(${aggregand});
        }
        for (const tuple of ptuples)
        {
          tuple._outproductsgb.add(productGB);
        }
        productGB._outgb = groupby;
      }
`;
  }


  const atom = body[i];

  if (atom instanceof Atom)
  {
    const tuple = "tuple" + i;
    const pred = atom.pred;
    const bindUnboundVars = [];
    const conditions = [];
    atom.terms.forEach((term, i) => {
      if (term instanceof Var)
      {
        if (compileEnv.has(term.name))
        {
          conditions.push(`${tuple}.t${i} === ${term.name}`);
        }
        else
        {
          bindUnboundVars.push(`const ${term.name} = ${tuple}.t${i};`);
          compileEnv.add(term.name);
        }
      }
      else if (term instanceof Lit)
      {
        conditions.push(`${tuple}.t${i} === ${termToString(term.value)}`);
      }
      else
      {
        throw new Error();
      }
    });

    if (conditions.length === 0)
    {
      return `
      // atom ${atom} [no conditions]
      for (const ${tuple} of (deltaPos === ${i} ? deltaTuples : ${pred}_.members))
      {
        ${bindUnboundVars.join('\n        ')}
        ${compileRuleGBFireBody(ruleName, head, body, i+1, compileEnv, ptuples)}
      }
      `;  
    }
    else
    {
      return `
      // atom ${atom} [conditions]
      for (const ${tuple} of (deltaPos === ${i} ? deltaTuples : ${pred}_.members))
      {
        if (${conditions.join('&&')})
        {
          ${bindUnboundVars.join('\n        ')}
          ${compileRuleGBFireBody(ruleName, head, body, i+1, compileEnv, ptuples)}
        }
      }
      `;  
    }
  }

  if (atom instanceof Assign)
  {
    assertTrue(atom.operator === '='); // nothing else supported at the moment
    assertTrue(atom.left instanceof Var); // nothing else supported at the moment
    const name = atom.left.name;
    if (compileEnv.has(name))
    {
      throw new Error("assigning bound name: " + name);
    }
    compileEnv.add(name);
    const left = compileTerm(atom.left);
    const right = compileTerm(atom.right);
    return `
      // assign ${atom}
      const ${left} = ${right};

      ${compileRuleGBFireBody(ruleName, head, body, i+1, compileEnv, ptuples)}
    `;
  }

  throw new Error(body[i]);
}

// (R x sum<z>) :- (X x) (I x y), z = y*y 
function emitRuleGBObject(rule)
{
  const pred = rule.head.pred;
  const ruleName = "Rule" + rule._id;
  const compileEnv = new Set();
  const gbNames = Array.from(Array(rule.head.terms.length - 1), (_, i) => "groupby.t"+i);
  const aggregandName ="t" + (rule.head.terms.length - 1);

  const GBclass = emitRuleGBClass(rule, ruleName);

  return `
/* rule [aggregates] 
${rule} 
*/
const ${ruleName} =
{
  name : '${ruleName}',

  fire(deltaPos, deltaTuples)
  {
    const newTuples = new Set();
    const updates = new Map(); // groupby -> additionalValues

    ${compileRuleGBFireBody(ruleName, rule.head, rule.body, 0, compileEnv, [])}
    
    // bind head ${rule.head}
    for (const [groupby, additionalValues] of updates)
    {
      const currentResultTuple = groupby._outtuple;
      const currentValue = currentResultTuple === null ? 0 : currentResultTuple.${aggregandName};
      const updatedValue = additionalValues.reduce((acc, val) => acc + val, currentValue);
      const updatedResultTuple = new ${pred}(${gbNames.join()}, updatedValue);  
      if (groupby._outtuple !== updatedResultTuple)
      {
        groupby._outtuple = updatedResultTuple;
        newTuples.add(updatedResultTuple);
      }
    }
    return newTuples;
  }
} // end ${ruleName}

${GBclass}

  `;
}

function emitRuleGBClass(rule, ruleName)
{
  const numGbTerms = rule.head.terms.length - 1;
  const termNames = Array.from(Array(numGbTerms), (_, i) => "t" + i);
  const termEqualities = termNames.map(t => `Object.is(member.${t}, ${t})`);
  const termAssignments = termNames.map(t => `this.${t} = ${t}`);
  const termToStrings = termNames.map(t => `this.${t}`);
  const aggTerm = rule.head.terms[rule.head.terms.length - 1];
  return `
class ${ruleName}GB
{
  static members = [];
  _outtuple = null;

  constructor(${termNames.join(', ')})
  {
    for (const member of ${ruleName}GB.members)
    {
      if (${termEqualities.join(' && ')})
      {
        return member;
      }
    }
    ${termAssignments.join('; ')};
    this._id = ${ruleName}GB.members.length;
    ${ruleName}GB.members.push(this);
  }

  rule()
  {
    return ${ruleName};
  }

  toString()
  {
    return atomString('${rule.head.pred}', ${termToStrings.join(', ')}, ({toString: () => "${aggTerm}"}));
  }
}

  `;
}

function emitIterators(predNames, rules)
{
  const tupleYielders = predNames.map(pred => `yield* ${pred}_.members;`);
  const gbYielders = rules.flatMap((rule, i) => rule.aggregates() ? [`yield* Rule${i}GB.members;`] : []);
  const ruleNames = rules.map(rule => `Rule${rule._id}`);

  return `
function* tuples_()
{
  ${tupleYielders.join('\n  ')}
}

function* groupbys()
{
  ${gbYielders.join('\n  ')}
}  

function rules()
{
  return [${ruleNames.join(', ')}];
}
  `;
}

function emitReset(predNames, rules)
{
  const tupleResetters = predNames.map(pred => `${pred}_.members = new Set();`);
  const gbResetters = rules.flatMap((rule, i) => rule.aggregates() ? [`Rule${i}GB.members = new Set();`] : []);

  return `
export function reset()
{
  ${tupleResetters.join('\n  ')}
  ${gbResetters.join('\n  ')}

  Product.members = [];
  ProductGB.members = [];
  edbTuples_.clear();
}  
  `;
}

function compileTerm(term)
{
  if (term instanceof Var)
  {
    return term.name;
  }
  if (term instanceof Bin)
  {
    return compileTerm(term.left) + term.operator + compileTerm(term.right);
  }
  throw new Error("compile term error: " + term);
}


const emitImports = `import {
  MutableSets,
  Product, ProductGB, products, productsGB, TuplePartition,
  atomString,
} from './scriptlog-common.mjs';
`;

function emitNonRecursiveRuleAtom(atom, i, ruleName, producesPred)
{

  if (atom instanceof Atom)
  {
    const pred = atom.pred;
    return [`
      // atom ${i} ${atom}
      const ${ruleName}tuples${i} = ${ruleName}.fire(${i}, ${pred}tuples);
      MutableSets.addAll(${producesPred}tuples, ${ruleName}tuples${i});
    `];
  }
  return [];
}

function emitNonRecursiveRule(rule)
{
  const ruleName = "Rule" + rule._id;
  const producesPred = rule.head.pred;
  const atoms = rule.body.flatMap((atom, i) => emitNonRecursiveRuleAtom(atom, i, ruleName, producesPred));

  return `
    /* ${ruleName} [nonRecursive]
${rule}
    */
    ${atoms.join('\n    ')}
  `;
}

function emitRecursiveRuleAtom(atom, i, recursivePreds, ruleName, producesPred)
{
  if (atom instanceof Atom)
  {
    const pred = atom.pred;
    if (recursivePreds.has(pred))
    {
      return [`
        // atom ${i} ${atom}
        if (local${pred}.size > 0)
        {
          const ${producesPred}tuples${i} = ${ruleName}.fire(${i}, local${pred});
          MutableSets.addAll(${producesPred}tuples, ${producesPred}tuples${i});  
          MutableSets.addAll(new${producesPred}, ${producesPred}tuples${i});
        }    
      `];  
    }
  }
  return [];
}

function emitRecursiveRule(rule, recursivePreds)
{
  const ruleName = "Rule" + rule._id;
  const producesPred = rule.head.pred;
  const atoms = rule.body.flatMap((atom, i) => emitRecursiveRuleAtom(atom, i, recursivePreds, ruleName, producesPred));
  return `
    /* ${ruleName} [recursive]
${rule}
    */
    ${atoms.join('\n    ')}
  `;
}

function emitRecursiveRules(rules, recursivePreds)
{
  const producedPreds = [...rules.reduce((acc, rule) => acc.add(rule.head.pred), new Set())];

  // TODO these locals profit only in first step from addition that occurs within loop (cascade, through shared ref to general delta set)
  const locals = producedPreds.map(pred => `
    let local${pred} = ${pred}tuples;
  `);
  const news = producedPreds.map(pred => `
    const new${pred} = new Set();
  `);
  const localConditions = producedPreds.map(pred => `local${pred}.size > 0`);

  const fireRules = rules.map(rule => emitRecursiveRule(rule, recursivePreds));

  const transfers = producedPreds.map(pred => `
    local${pred} = new${pred}
  `);

  return `
    // recursive rules: ${rules.map(rule => "Rule" + rule._id).join(', ')}
    // produce: ${producedPreds}

    ${locals.join('')}
    while (${localConditions.join(' || ')})
    {
      ${news.join('\n    ')}
      ${fireRules.join('\n    ')}
  
      ${transfers.join('')}
    }

  `;
}

function stratumLogic(stratum)
{
  const sb = [];
  if (stratum.recursiveRules.length === 0 && stratum.nonRecursiveRules.length === 0)
  {
    assertTrue(stratum.preds.length === 1);
    const pred = stratum.preds[0];
    return `const ${pred}tuples = partition.get(${pred}_) || new Set();`;
  }

  const tupleIntroductions = stratum.preds.map(pred => `const ${pred}tuples = new Set();`);
  sb.push(tupleIntroductions.join('\n    '));

  const nonRecursiveRules = stratum.nonRecursiveRules.map(emitNonRecursiveRule);
  sb.push(nonRecursiveRules.join('\n    '));

  if (stratum.recursiveRules.length > 0)
  {
    const recursiveRules = emitRecursiveRules(stratum.recursiveRules, new Set(stratum.preds));
    sb.push(recursiveRules);
  }

  return sb.join('\n');
}

function emitEdbTuples()
{
  return `
  const edbTuples_ = new Set();

  export function edbTuples()
  {
    return new Set(edbTuples_);
  }  

  export function tuples()
  {
    const tuples = new Set();
    const wl = [...edbTuples_];

    while (wl.length > 0)
    {
      const tuple = wl.pop();
      if (!tuples.has(tuple))
      {
        tuples.add(tuple);
        for (const outproduct of tuple._outproducts)
        {
          wl.push(outproduct._outtuple);
        }
        for (const outproductgb of tuple._outproductsgb)
        {
          wl.push(outproductgb._outgb._outtuple);
        }
      }
    }
    return tuples;
  }
  `;
}

function emitAddTuples(strata)
{
  const strataLogic = strata.map((stratum, i) => {

    return `
    // stratum ${i}
    // preds: ${stratum.preds.join(', ')}
    // non-recursive rules: ${stratum.nonRecursiveRules.map(rule => "Rule" + rule._id)}
    // recursive rules: ${stratum.recursiveRules.map(rule => "Rule" + rule._id)}

    ${stratumLogic(stratum)}
  `;
  });

  return `
export function addTuples(freshEdbTuples)
{
  const partition = new TuplePartition();
  for (const edbTuple of freshEdbTuples)
  {
    if (!edbTuples_.has(edbTuple))
    {
      edbTuples_.add(edbTuple);
      partition.add(edbTuple);  
    }
  }
  
  ${strataLogic.join('\n')}
}
  `;
}


const emitRest = `
export function toDot()
{
  const tuples = [];
  function tupleTag(tuple)
  {
    let id = tuples.indexOf(tuple);
    if (id === -1)
    {
      id = tuples.length;
      tuples.push(tuple);
    }
    return tuple.constructor.name + id;
  }

  function productTag(product)
  {
    return "p" + product._id;
  }

  function groupbyTag(gb)
  {
    return gb.rule().name + "gb" + gb._id;
  }
  
  let sb = "digraph G {\\nnode [style=filled,fontname=\\"Roboto Condensed\\"];\\n";

  for (const tuple of tuples_())
  {
    const t = tupleTag(tuple);
    sb += \`\${t} [shape=box label="\${tuple}"];\\n\`;
    for (const product of tuple._outproducts)
    {
      sb += \`\${t} -> \${productTag(product)};\\n\`;    
    }
    for (const productGB of tuple._outproductsgb)
    {
      sb += \`\${t} -> \${productTag(product)};\\n\`;    
    }
  }

  for (const product of products())
  {
    const p = productTag(product);
    sb += \`\${p} [label="\${product.rule.name}"];\\n\`;
    sb += \`\${p} -> \${tupleTag(product._outtuple)};\\n\`;    
  }

  for (const productGB of productsGB())
  {
    const p = productTag(productGB);
    sb += \`\${p} [label="\${productGB.value}"];\\n\`;
    sb += \`\${p} -> \${groupbyTag(productGB._outgb)};\\n\`;    
  }

  for (const groupby of groupbys())
  {
    const gb = groupbyTag(groupby);
    sb += \`\${gb} [shape=diamond label="\${groupby}"];\\n\`;
    const tuple = groupby._outtuple;
    if (tuple)
    {
      sb += \`\${gb} -> \${tupleTag(tuple)};\\n\`;
    }
  }
  sb += "}";
  return sb;
}
`;


// const result = compileFile("example1");
// console.log(String(result));
// console.log("done");

