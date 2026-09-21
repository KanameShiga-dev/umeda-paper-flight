#!/usr/bin/env node
// 扉タイミング検証シミュレータ
//   index.html の STAGES と列車状態機械を再現し、9線すべてを通過できる確率を測る。
//   人・操縦の難しさは対象外。紙ヒコーキの到達時刻は (4 + 7.6k) / 12 秒（k=0..8）。
//   使い方: node tools/sim.js [--trials=1000] [--mode=before|after|both]
'use strict';
const fs=require('fs'),path=require('path');

// ---- index.html から STAGES とスケジューラ定数を取り出す（値の二重管理を避ける）----
const HTML=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(re,label){const m=HTML.match(re);if(!m)throw new Error(label+' を index.html から取得できません');return m[1];}
const STAGES=eval('['+grab(/const STAGES=\[([\s\S]*?)\n\];/,'STAGES')+']');
const hasSched=/const WIN_T0=/.test(HTML);
const WIN_T0    = hasSched?+grab(/const WIN_T0=([\d.]+)/,'WIN_T0'):3;
const TMIN      = hasSched?eval(grab(/const TMIN=(\[[^\]]*\])/,'TMIN')):null;
const TMAX      = hasSched?eval(grab(/const TMAX=(\[[^\]]*\])/,'TMAX')):null;
const BLOCK_DEP = hasSched?+grab(/const BLOCK_DEPART=([\d.]+)/,'BLOCK_DEPART'):11.73;
const BLOCK_ARR = hasSched?+grab(/const BLOCK_ARRIVE=([\d.]+)/,'BLOCK_ARRIVE'):7.14;
const STAGGER   = hasSched?+grab(/WIN_STAGGER=([\d.]+)/,'WIN_STAGGER'):0.3;

// ---- index.html と同じ世界定数 ----
const TRACKS=9,CAR=2.8,PLAT=4.8,PER=CAR+PLAT,FIRST=4.0;
const CARLEN=19,CARHALF=9.3,NCARS=8,DOORPOS=[-6.2,0,6.2],DOOR_HW=0.65,MARGIN=0.1;
const REAR=4*CARLEN+CARHALF, FRONT=3*CARLEN+CARHALF;
const winSlack=()=>Math.max(0.3,Math.min(STAGGER,
  ST.winPeriod-(ST.winLen+TMAX[TRACKS-1]-TMIN[0])-BLOCK_DEP));

let seed=1;const rnd=()=>{seed=(seed*16807)%2147483647;return (seed-1)/2147483646;};
const rr=a=>a[0]+rnd()*(a[1]-a[0]);

// ---- 列車 ----
let ST=STAGES[0],trains=[],clockT=0,sched=false;
function build(s){
  seed=s;trains=[];clockT=0;
  for(let i=0;i<TRACKS;i++){
    const zn=FIRST+i*PER;
    const tr={i,zn,hx:i===0?0:(rnd()*2-1)*0.35,ox:0,open:1,state:'open',t:0,dur:0,ph:rnd()*winSlack()};
    if(i>0&&rnd()<ST.emptyP){tr.state='empty';tr.open=0;tr.ox=999;tr.dur=rr(ST.empty)*rnd();}
    else{tr.dur=rr(ST.dwell)*(0.35+rnd()*0.8)+(i<2?4:0);}
    trains.push(tr);
  }
  for(const tr of trains)tr.dur=plan(tr,tr.dur,tr.state==='empty'?BLOCK_ARR:BLOCK_DEP);
}
// 線 i の保証区間のうち [t0,t1] と重なるもの（index.html と同じ）
function guardHit(i,t0,t1){
  const P=ST.winPeriod,a=TMIN[i],b=ST.winLen+TMAX[i];let s=1/0,e=-1;
  for(let k=Math.max(0,Math.floor((t0-WIN_T0-b)/P));k<=Math.ceil((t1-WIN_T0-a)/P);k++){
    const ws=WIN_T0+k*P;if(ws+a<=t1&&ws+b>=t0){s=Math.min(s,ws+a);e=Math.max(e,ws+b);}}
  return e<0?null:{s,e};
}
function plan(tr,dur,block){
  if(!sched)return dur;
  const h=guardHit(tr.i,clockT+dur,clockT+dur+block);
  if(!h)return dur;
  const early=h.s-0.15-block-clockT;
  if(early>=dur*0.25){
    const lo=Math.max(dur*0.25,early-6),d=lo+rnd()*(early-lo);
    if(!guardHit(tr.i,clockT+d,clockT+d+block))return d;}
  return h.e+0.05+tr.ph-clockT;
}
function hold(tr,T,block){
  if(!sched)return false;
  const h=guardHit(tr.i,clockT,clockT+block);
  if(!h)return false;
  tr.dur=T+(h.e-clockT)+0.05+tr.ph;return true;
}
let departs=0;
function go(tr,st,dur){
  if(st==='depart')departs++;
  if(st==='open')dur=plan(tr,dur,BLOCK_DEP);else if(st==='empty')dur=plan(tr,dur,BLOCK_ARR);
  tr.state=st;tr.t=0;tr.dur=dur;
}
function updTrain(tr,dt){
  tr.t+=dt;const T=tr.t,D=tr.dur;
  switch(tr.state){
    case 'open':if(T>D&&!hold(tr,T,BLOCK_DEP))go(tr,'warn',2.6);break;
    case 'warn':if(T>D)go(tr,'closing',1.1);break;
    case 'closing':tr.open=Math.max(0,1-T/D);if(T>D){tr.open=0;go(tr,'closed',0.9);}break;
    case 'closed':if(T>D)go(tr,'depart',0);break;
    case 'depart':tr.ox=0.5*3.2*T*T;if(tr.ox>100){tr.ox=999;go(tr,'empty',rr(ST.empty));}break;
    case 'empty':if(T>D&&!hold(tr,T,BLOCK_ARR))go(tr,'arrive',7);break;
    case 'arrive':{const u=Math.min(1,T/D);tr.ox=100*(1-u)*(1-u);if(u>=1){tr.ox=0;go(tr,'opening',0.9);}}break;
    case 'opening':tr.open=Math.min(1,T/D);if(T>D){tr.open=1;go(tr,'open',rr(ST.dwell));}break;
  }
}
// x=0 を通過できるか（index.html の collide() の扉判定と同じ条件）
function passable(tr){
  if(tr.state==='empty')return true;
  const b=tr.hx+tr.ox;
  if(!(0>=b-REAR&&0<=b+FRONT))return true;          // 車体が x=0 を覆っていない
  const need=DOOR_HW*tr.open-MARGIN;
  if(need<=0)return false;
  for(let c=0;c<NCARS;c++){const cc=b+(c-4)*CARLEN;
    for(const d of DOORPOS)if(Math.abs(cc+d)<need)return true;}
  return false;
}

// ---- 1試行 ----
const DT=1/60, TMAX_SIM=150;
const T_NEAR=[...Array(TRACKS)].map((_,k)=>(FIRST+PER*k)/12);        // 手前の面に届く時刻
const T_FAR =[...Array(TRACKS)].map((_,k)=>(FIRST+PER*k+CAR)/12);    // 奥の面を抜ける時刻
function trial(s){
  build(s);
  const N=Math.floor(TMAX_SIM/DT), ok=new Uint8Array(N*TRACKS);
  for(let n=0;n<N;n++){
    clockT+=DT;
    for(const tr of trains)updTrain(tr,DT);
    for(let i=0;i<TRACKS;i++)ok[n*TRACKS+i]=passable(trains[i])?1:0;
  }
  return ok;
}
const at=(ok,t,i)=>{const n=Math.floor(t/DT);return n>=0&&n<ok.length/TRACKS?ok[n*TRACKS+i]:0;};
function canClear(ok,t0){
  for(let i=0;i<TRACKS;i++)if(!at(ok,t0+T_NEAR[i],i)||!at(ok,t0+T_FAR[i],i))return false;
  return true;
}
// 投擲時刻がウィンドウ内か（保証区間の起点 ws から ws+winLen）
const inWindow=t=>{const P=ST.winPeriod;const k=Math.floor((t-WIN_T0)/P);return k>=0&&(t-WIN_T0-k*P)<=ST.winLen;};
// 保証の影響が完全に切れた時刻（保証区間の最終端より後、次のウィンドウの2秒前まで）
const deepOut=t=>{const P=ST.winPeriod,k=Math.floor((t-WIN_T0)/P);if(k<0)return false;
  const r=t-WIN_T0-k*P;return r>=ST.winLen+Math.max(...TMAX)&&r<=P-2;};

function rate(ok,pred,lo,hi,step){let n=0,c=0;
  for(let t=lo;t<=hi;t+=step){if(pred&&!pred(t))continue;n++;if(canClear(ok,t))c++;}
  return n?{n,c}:null;}

function run(mode,trials){
  sched=(mode==='after');
  const out=[];
  for(let si=0;si<STAGES.length;si++){
    ST=STAGES[si];
    const acc={imm:[0,0],wait:[0,0],win:[0,0],out:[0,0],deep:[0,0]};departs=0;
    for(let tr=0;tr<trials;tr++){
      const ok=trial((tr*7919)%99991+11);
      for(const [key,lo,hi,pred] of [['imm',0,3,null],['wait',60,90,null],
          ['win',3,140,inWindow],['out',3,140,t=>!inWindow(t)],['deep',3,140,deepOut]]){
        if((key==='win'||key==='out')&&mode!=='after'&&key==='win')continue;
        const r=rate(ok,pred,lo,hi,0.05);if(!r)continue;
        acc[key][0]+=r.n;acc[key][1]+=r.c;
      }
    }
    const pc=k=>acc[k][0]?(100*acc[k][1]/acc[k][0]):null;
    out.push({stage:ST.name,imm:pc('imm'),wait:pc('wait'),win:pc('win'),out:pc('out'),deep:pc('deep'),dep:(departs/trials/9).toFixed(1)});
  }
  return out;
}
function table(title,rows,cols){
  console.log('\n'+title);
  console.log(cols.map(c=>c[1]).join(''));
  for(const r of rows)console.log(cols.map(c=>{
    const v=r[c[0]];return (v===null||v===undefined?'-':typeof v==='number'?v.toFixed(1)+'%':v).padStart(c[1].length);
  }).join(''));
}
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
const trials=+(args.trials||1000), mode=args.mode||'both';
// 調整用: 特定ステージの周期/長さを上書きして試す  例) --stage=4 --period=50
if(args.stage!==undefined){const S0=STAGES[+args.stage];
  if(args.period)S0.winPeriod=+args.period;if(args.len)S0.winLen=+args.len;}
console.log(`試行数 ${trials} / ステージ ${STAGES.length} / スケジューラ実装: ${hasSched?'あり':'なし（修正前）'}`);
if(mode==='before'||mode==='both'){
  if(hasSched)console.log('（before: index.html にスケジューラはあるが無効化して計測）');
  table('■ 修正前（ウィンドウなし）',run('before',trials),
    [['stage','ステージ      '],['imm','  開始3秒以内'],['wait','  60秒以降'],['out','  全時刻'],['dep','  発車/線']]);
}
if((mode==='after'||mode==='both')&&hasSched){
  table('■ 修正後（ウィンドウあり）',run('after',trials),
    [['stage','ステージ      '],['win','  ウィンドウ中'],['out','  ウィンドウ外'],['deep','  ウィンドウ遠方'],['dep','  発車/線']]);
}else if(mode==='after'||mode==='both'){
  console.log('\n■ 修正後: index.html にスケジューラが未実装のため測定しません');
}
