import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadStrategy} from '../../src/config/strategy.js';
import {emptyScores, INTERVAL_MS} from '../../src/market.js';
import {openDatabase} from '../../src/store/db.js';
import {createPoolStore} from '../../src/store/pool.js';
import {createRuntimeStore, initialRound, pendingMember} from '../../src/store/runtime.js';
import {createSeriesStore} from '../../src/store/series.js';
import {readObservationInputs, readMarketInputs} from '../../src/store/snapshot.js';
import {SAMPLE_STRATEGY, poolItem, candle} from '../helpers.js';

test('新发现成员可读取刚采集的验证行情，评分与当前T隔离且不修改原快照', t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const cfg=loadStrategy(SAMPLE_STRATEGY);const T=100*INTERVAL_MS['1d'];
  const pools=createPoolStore(db);pools.upsertPool([poolItem('old'),poolItem('new')],T);
  const state=createRuntimeStore(db), series=createSeriesStore(db);
  const member={...pendingMember(pools.getPoolItem('old')!,1),seriesId:null,rpsScores:{...emptyScores(),r16:99}};
  const previous={...initialRound(cfg,T),boardComplete:true,status:'complete' as const,completedAt:T,members:[member]};
  state.saveRound(previous);
  const next={...initialRound(cfg,T+1000),boardComplete:true,members:[{...member,rpsScores:emptyScores()},
    {...pendingMember(pools.getPoolItem('new')!,0),seriesId:null}]};
  state.saveObservationRound(next);
  const identity=series.ensureSeries({source:'geckoterminal',network:'solana',ca:'new',poolAddress:'pool-new',currency:'usd',formatVersion:1},T);
  series.upsertCandles(identity.id,'15m',[candle(T-INTERVAL_MS['15m'],42)]);series.activateSeries(identity.id,T);
  const inputs=readObservationInputs(db,cfg,T+2000);
  assert.deepEqual(inputs.map(i=>i.ca),['old','new']);
  assert.ok(inputs.every(i=>Object.values(i.rpsScores).every(v=>v===null)&&i.rpsBounds===undefined));
  assert.equal(inputs[1]!.candles15m[0]!.close,42);
  assert.equal(state.getObservationRound()!.members[1]!.seriesId,null);
  assert.deepEqual(readMarketInputs(db,cfg,T+2000).map(i=>i.ca),['old']);
  assert.equal(readMarketInputs(db,cfg,T+2000)[0]!.rpsScores.r16,99);
});

test('不完整发现、异配置快照不能作为新观察详情，null身份不读无来源legacy',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const cfg=loadStrategy(SAMPLE_STRATEGY), state=createRuntimeStore(db), pools=createPoolStore(db);
  pools.upsertPool([poolItem('a')],0);const member={...pendingMember(pools.getPoolItem('a')!,1),seriesId:null};
  const running={...initialRound(cfg,0),members:[member]};state.saveRound(running);
  assert.deepEqual(readObservationInputs(db,cfg,1),[]);
  const complete={...running,boardComplete:true};state.saveObservationRound(complete);
  assert.deepEqual(readObservationInputs(db,cfg,1)[0]!.candles15m,[]);
  const other=structuredClone(cfg);other.pool.historyDays=4;
  assert.deepEqual(readObservationInputs(db,other,1),[]);
});
