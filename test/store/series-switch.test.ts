import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../../src/store/db.js';
import { createSeriesStore } from '../../src/store/series.js';
import { candle } from '../helpers.js';
const ca='0x'+'ab'.repeat(20);

test('显式切换CAS与审计原子提交，旧源历史和时刻保留，幂等不重复记账', t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const s=createSeriesStore(db);
 const old=s.ensureSeries({source:'geckoterminal',network:'eth',ca,poolAddress:'0x'+'cd'.repeat(20),currency:'usd',formatVersion:1},10);
 const next=s.ensureSeries({source:'gmgn',scope:'token',network:'eth',ca,poolAddress:null,currency:'usd',formatVersion:1},11);
 s.upsertCandles(old.id,'15m',[candle(0,10)]);s.upsertMoments(old.id,[{moment:1,barTime:0,price:10}],12);s.activateSeries(old.id,12);
 assert.equal(s.getTokenSeries('eth',ca.toUpperCase())?.id,next.id);
 assert.equal(s.getTokenSeries('base',ca),null);
 assert.throws(()=>s.switchActiveSeries(next.id,old.id,13,'gmgn_ready_at_new_t'),{code:'SERIES_EMPTY'});
 s.upsertCandles(next.id,'15m',[candle(0,20)]);
 assert.throws(()=>s.switchActiveSeries(next.id,null,13,'gmgn_ready_at_new_t'),{code:'SERIES_CONFLICT'});
 assert.equal(s.getActive('eth',ca)?.id,old.id);
 const switched=s.switchActiveSeries(next.id,old.id,14,'gmgn_ready_at_new_t');
 assert.equal(switched.id,next.id);assert.equal(switched.active,true);assert.equal(s.getSeries(old.id)?.active,false);
 assert.equal(s.getCandles(old.id,'15m')[0]?.close,10);assert.equal(s.getMoments(old.id).length,1);
 assert.equal(s.getCandles(next.id,'15m')[0]?.close,20);assert.equal(s.getMoments(next.id).length,0);
 assert.deepEqual(db.prepare('SELECT network,ca,previous_series_id,next_series_id,switched_at,reason FROM market_series_switches').all(),
  [{network:'eth',ca,previous_series_id:old.id,next_series_id:next.id,switched_at:14,reason:'gmgn_ready_at_new_t'}]);
 assert.deepEqual(s.switchActiveSeries(next.id,next.id,15,'gmgn_ready_at_new_t'),switched);
 assert.deepEqual(db.prepare('SELECT count(*) AS n FROM market_series_switches').get(),{n:1});
 assert.throws(()=>s.switchActiveSeries(next.id,old.id,16,'gmgn_ready_at_new_t'),{code:'SERIES_CONFLICT'});
});

test('评分外层事务失败同时回滚切换与审计，新CA初始化仍需有效身份和历史', t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const s=createSeriesStore(db);
 const token=s.ensureSeries({source:'gmgn',scope:'token',network:'eth',ca,poolAddress:null,currency:'usd',formatVersion:1},10);
 s.upsertCandles(token.id,'15m',[candle(0,2)]);
 assert.throws(()=>db.transaction(()=>{s.switchActiveSeries(token.id,null,11,'gmgn_new_asset');throw new Error('rollback');})(),/rollback/);
 assert.equal(s.getActive('eth',ca),null);assert.deepEqual(db.prepare('SELECT count(*) AS n FROM market_series_switches').get(),{n:0});
 for(const [at,reason] of [[9,'gmgn_new_asset'],[11,'RAW ERROR TEXT']] as const)
  assert.throws(()=>s.switchActiveSeries(token.id,null,at,reason),{code:'SERIES_SWITCH_INVALID'});
 const invalid=s.ensureSeries({source:'gmgn',scope:'token',network:'base',ca,poolAddress:null,currency:'usd',formatVersion:2},10);
 s.upsertCandles(invalid.id,'15m',[candle(0,2)]);
 assert.throws(()=>s.switchActiveSeries(invalid.id,null,11,'gmgn_new_asset'),{code:'SERIES_SWITCH_INVALID'});
 assert.equal(s.switchActiveSeries(token.id,null,11,'gmgn_new_asset').active,true);
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
