export class Program
{
  constructor(rules)
  {
    this.rules = rules;
  }

  toString()
  {
    return this.rules.join('\n');
  }
}

export class Rule
{
  static counter = 0;
  constructor(head, body)
  {
    this.head = head;
    this.body = body;
    this._id = Rule.counter++;
  }

  aggregates()
  {
    return this.head.terms[this.head.terms.length - 1] instanceof Agg;
  }

  toString()
  {
    return `${this.head} :- ${this.body.join()}`;
  }
}

export class Atom
{
  constructor(pred, terms)
  {
    this.pred = pred;
    this.terms = terms;
  }

  arity()
  {
    return this.terms.length;
  }

  toString()
  {
    return `[${this.pred} ${this.terms.join(' ')}]`;
  }
}

export class Neg
{
  constructor(atom)
  {
    this.atom = atom;
  }

  toString()
  {
    return "¬" + this.atom;
  }
}

export class Agg
{
  constructor(aggregator, aggregand)
  {
    this.aggregator = aggregator;
    this.aggregand = aggregand;
  }

  toString()
  {
    return `{${this.aggregator}: ${this.aggregand}}`;
  }
}

export class Lit
{
  constructor(value)
  {
    this.value = value;
  }

  toString()
  {
    const value = this.value;
    if (typeof value === "string")
    {
      return "'" + value + "'";
    }
    return String(value);
  }
}

export class Var
{
  constructor(name)
  {
    this.name = name;
  }

  toString()
  {
    return String(this.name);
  }
}

export class Assign
{
  constructor(operator, left, right)
  {
    this.operator = operator;
    this.left = left;
    this.right = right;
  }

  toString()
  {
    return `${this.left}${this.operator}${this.right}`;
  }
}