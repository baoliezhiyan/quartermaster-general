import { compileOffer } from '../../src/localAi/contract';
import type { Offer, Submission } from '../../src/localAi/contract';
import type { observePlayer } from '../../src/localAi/observation';
import type { referenceData } from '../../src/localAi/reference';

export type Observation = Extract<ReturnType<typeof observePlayer>, { public: unknown }>;
type VisibleCard = Observation['privateCountries'][string]['hand'][number];
type Reference = Awaited<ReturnType<typeof referenceData>>['data'];
export type Question = { text: string; kind: 'fact_read' | 'rule_application' };
export const PROMPT_VERSION = 'qm-qwen-baseline/1';
export const RULES = [
  '你在玩正式完整版战场军需官。按当前授权观察、规则开关、卡面与合法候选决策。',
  '轴心是德国、日本、意大利。同盟是英国、苏联、美国。英美分别操作法中附属国家。轮次按德英日苏意美。',
  '优先考虑阵营获胜。美国行动结束时领先至少30分可提前结束，或20轮后以总分决胜（轴心结算加0.5分）。',
  '正式回合依次是回合开始、出牌、空军、补给、计分、弃牌、摸牌。序章及中立以当前开关、牌面和候选为准。',
  '建设通常需要邻接本国已有补给部队且新单位获得补给。陆军大本营重建有例外。征召使用牌面给定地点，不要求当下建立补给线。',
  '补给按实际连通关系从补给源传播。盟国占领不等于共享补给。海军还需邻接友方陆军，后者不必有补给。临时效果以当前生效规则为准。',
  '新征召的无补给单位可以等到本国补给检查前连通。检查只处理当前阶段负责的陆海军，空军在失去底座后按规则调度。',
  '占领计分点的陆军通常独占2分，共占时每国1分。本土被敌占时该国通常失去计分资格，附属国按实际计分规则处理。',
  '陆海战可以出现空军防御和拦截。直接消灭与发起战斗有区别。重复建设或原地调度可能产生连携，单看位置未变无法判断效果。',
  '当下合法不保证后续效果有目标或能支付。读卡面、窗口来源、兵模储备及费用。未知敌牌和未来随机结果都未知。',
  '只输出一个JSON对象，格式 {"offer":整数,"select":{"字段":[整数]} }。offer 对应候选编号，数组值对应该字段自己的选项编号。',
  '只有候选提供的字段可以提交。无字段用 {}，数量允许0时可用空数组。按要求排序。请勿输出解释或思考过程。',
].join('\n');

function relevantOffers(o: Observation) {
  // Routine notices remain visible. Acknowledge only when the engine has no other action,
  // or explicitly blocks on reveal confirmation.
  const actions = o.offers.filter(v => v.command.type !== 'ACK_RESPONSE_NOTICE'
    || (o.resolutionRunning && !o.decisions.length && o.blockingNoticeSeats.includes(v.seat)));
  return actions.length ? actions : o.offers;
}

export function makeInput(o: Observation, ref: Reference, question?: Question, previous?: unknown) {
  if (ref.id !== o.reference.id || ref.rulesFingerprint !== o.reference.rulesFingerprint) {
    throw Error('REFERENCE_MISMATCH');
  }
  const offers = relevantOffers(o);
  const decisions = new Map(o.decisions.map(q => [q.id, q]));
  const candidateIds = new Set(offers.flatMap(offer => Object.values(offer.selections ?? {}).flatMap(s => s.ids)));
  const cards = new Map<string, VisibleCard>();
  const remember = (entries: Iterable<VisibleCard>) => {
    for (const card of entries) if (card.definitionId !== 'hidden') cards.set(card.id, card);
  };
  const own = Object.fromEntries(Object.entries(o.privateCountries).map(([seat, d]) => {
    const prelude = d.prelude;
    remember([...d.hand, ...d.active, ...d.faceDown, ...d.resolving]);
    remember([...d.deckComposition, ...d.discard, ...d.removed].filter(c => candidateIds.has(c.id)));
    if (prelude) remember([...prelude.hand, ...(prelude.knownTop ? [prelude.knownTop] : []),
      ...[...prelude.deckComposition, ...prelude.discard].filter(c => candidateIds.has(c.id))]);
    const composition: Record<string, number> = {};
    for (const c of d.deckComposition) composition[c.definitionId] = (composition[c.definitionId] ?? 0) + 1;
    return [seat, {
      hand: d.hand.map(c => c.id), active: d.active.map(c => c.id), faceDown: d.faceDown.map(c => c.id),
      resolving: d.resolving.map(c => c.id), discard: d.discard.map(c => [c.id,c.name]),
      remainingDeckCountsByDefinition: composition,
      prelude: prelude ? { hand: prelude.hand.map(c => c.id), knownTop: prelude.knownTop?.id } : null,
      notices: d.notices?.filter(n => !n.readBy.includes(seat as never)), uses: d.uses, roundUses: d.roundUses,
      disabledResponseIds: d.disabledResponseIds,
    }];
  }));
  const countries = Object.fromEntries(Object.entries(o.public.countries).map(([seat, d]) => {
    remember([...d.active, ...d.revealedResponses]);
    return [seat, {...d, active:d.active.map(c=>c.id), revealedResponses:d.revealedResponses.map(c=>c.id),
      visibleDiscard:d.visibleDiscard.map(c=>[c.id,c.name])}];
  }));
  const adjacency = new Map<string, { countries: string[]; edges: [string,string][] }>();
  const mapCountries = Object.fromEntries(Object.entries(o.mapFacts.countries).map(([id, {adjacency: graph, ...facts}]) => {
    const signature = JSON.stringify(graph);
    let group = adjacency.get(signature);
    if (!group) {
      group = { countries: [], edges: Object.entries(graph).flatMap(([a, ns]) =>
        ns.filter(b => a < b).map(b => [a,b] as [string,string])) };
      adjacency.set(signature, group);
    }
    group.countries.push(id);
    return [id, facts];
  }));
  const mapped = offers.map((offer, index) => {
    const q = decisions.get(String(offer.command.choiceId));
    const fields = Object.fromEntries(Object.entries(offer.selections ?? {}).map(([key, spec]) => [
      key, {
        min: spec.min, max: spec.max, ordered: spec.ordered ?? false, requirements: spec.requirements,
        values: spec.ids.map((id, n) => {
          const option = q?.options.find(v => v.id === id);
          return { n, id, label: option?.label ?? cards.get(id)?.name,
            windowId: option?.windowId, mergedWindowIds: option?.mergedWindowIds, region: option?.regionId, details: option?.details };
        }),
      },
    ]));
    return { offer: index, id: offer.id, seat: offer.seat, action: offer.command.type,
      label: offer.label, card: offer.command.cardId, details: offer.details, choice: q?.id, fields };
  });
  const { log, units: _units, suppliedUnitIds: _supplied, countries: _countries, ...board } = o.public;
  const sections = [
    ['身份与当前决策权', {bindings:o.bindings, alliance:o.alliance, activeSeat:o.activeSeat, decisionSeats:o.decisionSeats}],
    ['当前局势', {round:o.round, phase:o.phase, rules:o.rules, ...board, countries,
      regions:ref.map.regions.map(r=>[r.id,r.name,r.type,r.supply,r.homeCountry]),
      regionFields:['id','name','type','printedSupplyAndScore','printedHome'],
      straits:ref.map.straits.map(s=>({...s, currentController:o.mapFacts.landControllers[s.landRegion]??s.defaultController})),
      landControl:o.mapFacts.landControllers, currentAdjacency:[...adjacency.values()],
      mapCountries, units:o.mapFacts.units, temporarySupply:o.mapFacts.temporarySupply,
      own, cardTextFields:['instanceId','definitionId','name','type','text','tension','country'], cardTexts:[...cards.values()].map(c=>[c.id,c.definitionId,c.name,c.type,c.text,c.tension,c.country]),
    }],
    ['当前选择与触发', {windows:o.decisions.map(({options: _options,...q})=>q),
      ownResolutionFacts:o.resolutionFacts, recentPublicActions:log?.slice(-6), previous, question:question?.text}],
    ['合法候选与字段范围', mapped],
  ];
  const messages = [
    {role:'system',content:RULES+(question ? '\n本题还须输出 answer 字段，值按诊断问题要求，只回答事实。' : '')},
    {role:'user',content:sections.map(([name,data])=>name+'\n'+JSON.stringify(data)).join('\n\n')},
  ];
  return { offers, messages };
}

export function parseAction(text: string, offers: Offer[], observation: Observation, requestId: string, question?: Question) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  const value = JSON.parse(cleaned);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['offer','select',...(question ? ['answer'] : [])].includes(key))) {
    throw Error('输出必须是符合指定字段的单个 JSON 对象');
  }
  const offer = Number.isSafeInteger(value.offer) ? offers[value.offer] : undefined;
  if (!offer) throw Error('offer 编号不在当前候选内');
  if (!value.select || typeof value.select !== 'object' || Array.isArray(value.select)) throw Error('select 必须是对象');
  if (question && typeof value.answer !== 'string') throw Error('诊断需要字符串 answer');
  const selections: Record<string, string[]> = {};
  for (const [key, indices] of Object.entries(value.select)) {
    const spec = offer.selections?.[key];
    if (!spec || !Array.isArray(indices) || !indices.every(n=>Number.isSafeInteger(n) && n>=0 && n<spec.ids.length)) {
      throw Error('参数 '+key+' 不是该候选允许的编号数组');
    }
    selections[key] = indices.map(n=>spec.ids[n]);
  }
  const request: Submission = {requestId, gameId:observation.gameId!, epoch:observation.epoch,
    revision:observation.revision!, offerId:offer.id, selections};
  compileOffer(offers, request);
  return { request, answer:value.answer as string|undefined, offer };
}
