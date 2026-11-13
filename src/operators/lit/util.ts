/**
 * Constructors for literature operators. Pure (type-only imports), so that
 * the registry can import the library without a cycle; the registry
 * validates and normalises every definition at registration.
 */
import type { DomOperatorDef, NetworkOperatorDef, TestOperatorDef } from '../registry';

type Common = {
  id: string;
  category: string;
  /** One sentence: the fault the operator models. */
  intent: string;
  /** Keys of docs/OPERATORS.md#references. */
  refs: string[];
  /** Source identifiers, e.g. "MAEWU:TMM". */
  aliases?: string[];
  defaults?: Record<string, unknown>;
};

const fam = (id: string) => id.split('.')[0];

export function domOp(o: Common & Omit<Partial<DomOperatorDef>, 'layer' | 'family'> & { scope: 'element' | 'page' }): DomOperatorDef {
  return { ...o, family: fam(o.id), layer: 'dom', defaults: o.defaults || {}, set: 'literature' } as DomOperatorDef;
}

export function netOp(o: Common & Omit<Partial<NetworkOperatorDef>, 'layer' | 'family'> & Pick<NetworkOperatorDef, 'handle'>): NetworkOperatorDef {
  return { ...o, family: fam(o.id), layer: 'network', defaults: o.defaults || {}, set: 'literature' } as NetworkOperatorDef;
}

export function testOp(o: Common & Omit<Partial<TestOperatorDef>, 'layer' | 'family'> & Pick<TestOperatorDef, 'findSites'>): TestOperatorDef {
  return { ...o, family: fam(o.id), layer: 'test', defaults: o.defaults || {}, set: 'literature' } as TestOperatorDef;
}
