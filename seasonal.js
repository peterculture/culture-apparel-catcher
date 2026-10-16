/*
 * seasonal.js -- seasonal + holiday-week theme for the dashboards (2026-10).
 *
 * WHAT IT DOES
 *   1. Works out today's theme: a holiday week if today falls in one
 *      (the Sunday-Saturday week containing the holiday), otherwise the season.
 *   2. Publishes it as CSS variables + a data attribute on <html>. tokens.css
 *      reads those to paint the header tagline, the board banner and the
 *      sidebar card. Text in those elements comes from CSS `content:`, so this
 *      script NEVER writes into an element the board's React tree owns --
 *      the boards re-render every second and would otherwise fight it.
 *   3. Draws the falling/floating animation on its own canvas, appended to
 *      <body> (outside the board's tree), pointer-events:none.
 *
 * SAFETY (why it cannot break a board)
 *   - Standalone: no dependency on CAApi, support.js or any board's state.
 *   - Everything is wrapped in try/catch. If it throws, <html> never gets
 *     data-ca-season, every themed element stays hidden/unstyled, and the
 *     board looks exactly like it did before this file existed.
 *   - Canvas z-index 35: above page content, BELOW the sticky header (40),
 *     the floating phone sidebar (50) and every drawer/modal (55-96).
 *   - Paused while the tab is hidden; off under prefers-reduced-motion, in
 *     print, and when the worker taps the card's "Effects" switch (saved per
 *     device in localStorage `caFxOff`).
 *   - Preview: add ?theme=<key> to any board URL (e.g. ?theme=halloween) to
 *     see a theme out of season. Keys: spring summer fall winter newyear
 *     valentine stpatricks easter july4 halloween thanksgiving christmas.
 */
(function () {
  'use strict';
  try {
    var IMG = './seasons/';
    var S = {
      spring: { name: 'Spring', img: 'spring.jpg', pos: 'center 60%', accent: '#F2A1C7', range: 'Mar 20 \u2013 Jun 20', fx: 'Petals' },
      summer: { name: 'Summer', img: 'summer.jpg', pos: 'center 55%', accent: '#3FC6E8', range: 'Jun 21 \u2013 Sep 21', fx: 'Sun glints' },
      fall:   { name: 'Fall',   img: 'fall.jpg',   pos: 'center 40%', accent: '#F08A3C', range: 'Sep 22 \u2013 Dec 20', fx: 'Falling leaves' },
      winter: { name: 'Winter', img: 'winter.jpg', pos: 'center 35%', accent: '#9FD3F5', range: 'Dec 21 \u2013 Mar 19', fx: 'Snow' }
    };
    function easter(y) { var a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1; return new Date(y,mo-1,da); }
    function thanks(y) { var d=new Date(y,10,1); return new Date(y,10,1+((4-d.getDay()+7)%7)+21); }
    var H = {
      newyear:      { name: "New Year's",    img: 'holidays/new-year.jpg',     pos: 'center 40%', accent: '#F6D27A', date: function (y) { return new Date(y,0,1); },  fx: 'Fireworks' },
      valentine:    { name: "Valentine's",   img: 'holidays/valentine.jpg',    pos: 'center 50%', accent: '#F472B6', date: function (y) { return new Date(y,1,14); }, fx: 'Floating hearts' },
      stpatricks:   { name: "St. Patrick's", img: 'holidays/st-patricks.jpg',  pos: 'center 25%', accent: '#4ADE80', date: function (y) { return new Date(y,2,17); }, fx: 'Shamrocks' },
      easter:       { name: 'Easter',        img: 'holidays/easter.jpg',       pos: 'center',     accent: '#C4B5FD', date: easter, fx: 'Easter eggs' },
      july4:        { name: '4th of July',   img: 'holidays/july-4.jpg',       pos: 'center 35%', accent: '#60A5FA', date: function (y) { return new Date(y,6,4); },  fx: 'Fireworks' },
      halloween:    { name: 'Halloween',     img: 'holidays/halloween.jpg',    pos: 'center 55%', accent: '#F97316', date: function (y) { return new Date(y,9,31); }, fx: 'Bats & embers' },
      thanksgiving: { name: 'Thanksgiving',  img: 'holidays/thanksgiving.jpg', pos: 'center 45%', accent: '#D97706', date: thanks, fx: 'Harvest leaves' },
      christmas:    { name: 'Christmas',     img: 'holidays/christmas.jpg',    pos: 'center 45%', accent: '#EF4444', date: function (y) { return new Date(y,11,25); }, fx: 'Snow & lights' }
    };

    function weekOf(d) { var s=new Date(d.getFullYear(),d.getMonth(),d.getDate()-d.getDay()); return { s: s, e: new Date(s.getFullYear(),s.getMonth(),s.getDate()+6) }; }
    function fmt(d) { return d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }

    function resolve() {
      var now=new Date(), today=new Date(now.getFullYear(),now.getMonth(),now.getDate()), Y=today.getFullYear();
      var forced=null; try { forced=new URLSearchParams(location.search).get('theme'); } catch (_) {}
      if (forced && S[forced]) return mkSeason(forced);
      if (forced && H[forced]) { var w=null; [Y,Y+1].forEach(function (y) { var x=weekOf(H[forced].date(y)); if (!w && x.e>=today) w=x; }); return mkHoliday(forced, w); }
      var hit=null;
      [Y-1,Y,Y+1].forEach(function (y) { Object.keys(H).forEach(function (k) { var x=weekOf(H[k].date(y)); if (today>=x.s && today<=x.e) hit={ k:k, w:x }; }); });
      if (hit) return mkHoliday(hit.k, hit.w);
      var md=(today.getMonth()+1)*100+today.getDate();
      return mkSeason(md>=320&&md<=620?'spring' : md>=621&&md<=921?'summer' : md>=922&&md<=1220?'fall' : 'winter');
    }
    function mkSeason(k) { var t=S[k]; return { key:k, name:t.name, range:t.range, img:IMG+t.img, pos:t.pos, accent:t.accent, fx:t.fx }; }
    function mkHoliday(k, w) { var t=H[k]; return { key:k, name:t.name+' week', range:fmt(w.s)+' \u2013 '+fmt(w.e), img:IMG+t.img, pos:t.pos, accent:t.accent, fx:t.fx }; }

    var th = resolve();
    var root = document.documentElement;
    var q = function (s) { return '"' + String(s).replace(/["\\]/g, '') + '"'; };
    function fxOff() { try { return localStorage.getItem('caFxOff') === '1'; } catch (_) { return false; } }
    function publish() {
      root.style.setProperty('--ca-season-img', 'url("' + th.img + '")');
      root.style.setProperty('--ca-season-pos', th.pos);
      root.style.setProperty('--ca-season-accent', th.accent);
      root.style.setProperty('--ca-season-name', q(th.name));
      root.style.setProperty('--ca-season-range', q(th.range));
      root.style.setProperty('--ca-season-fx', q((fxOff() ? 'Effects off \u00b7 ' : 'Effects on \u00b7 ') + th.fx));
      root.setAttribute('data-ca-theme', th.key);
    }
    // Only switch the themed elements on once the photo has actually loaded --
    // a missing file on the deploy (the tokens.css incident: Pages answers a
    // missing asset with index.html) then leaves the board untouched.
    // The animation waits for the photo too (10-05 review): without this, a
    // missing photo left the theme off but the leaves still falling.
    var photoOk = false;
    var probe = new Image();
    probe.onload = function () { try { publish(); root.setAttribute('data-ca-season', ''); photoOk = true; sync(); } catch (_) {} };
    probe.src = th.img;

    // "Effects on/off" switch inside the sidebar card -- delegated, so it never
    // needs a handler from the board.
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('[data-ca-fx-toggle]');
      if (!t) return;
      try { localStorage.setItem('caFxOff', fxOff() ? '0' : '1'); } catch (_) {}
      publish(); sync();
    });

    /* ---------------- animation ---------------- */
    var cv=null, ctx=null, raf=0, layers=null, last=0;
    function motionOk() {
      if (!photoOk || fxOff()) return false;
      try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch (_) {}
      return true;
    }
    function sync() { if (motionOk() && !document.hidden) start(); else stop(); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf=0; if (cv) { cv.remove(); cv=null; ctx=null; } }

    var R=function(a,b){return a+Math.random()*(b-a);}, pick=function(a){return a[Math.floor(Math.random()*a.length)];};
    var W=function(){return innerWidth;}, Hh=function(){return innerHeight;};
    var LEAF=['#C2410C','#D9622B','#E8A13A','#B91C1C','#9A3412'], HARVEST=['#92400E','#B45309','#D97706','#7C2D12','#A16207','#B91C1C'];
    var THEMES = {
      winter:[{n:70,t:'snow'}], fall:[{n:22,t:'leaf',pal:LEAF}], spring:[{n:28,t:'petal'}], summer:[{n:26,t:'glint'}],
      newyear:[{t:'fireworks',pal:['#F6D27A','#FFE9B0','#9FD3F5','#FFFFFF','#F9A8D4'],rate:.9},{n:34,t:'confetti',pal:['#F6D27A','#FFFFFF','#9FD3F5','#E5C07B']}],
      valentine:[{n:24,t:'heart',pal:['#F472B6','#EC4899','#FB7185','#FDA4AF','#E11D48']}],
      stpatricks:[{n:20,t:'shamrock',pal:['#22C55E','#16A34A','#4ADE80','#15803D']},{n:10,t:'coin'}],
      easter:[{n:16,t:'egg',pal:['#F9A8D4','#A5F3FC','#FDE68A','#C4B5FD','#BBF7D0','#FCA5A5']},{n:14,t:'petal'}],
      july4:[{t:'fireworks',pal:['#EF4444','#FFFFFF','#3B82F6'],rate:1.3},{n:16,t:'star',pal:['#EF4444','#FFFFFF','#60A5FA']}],
      halloween:[{n:6,t:'bat'},{n:26,t:'ember'}],
      thanksgiving:[{n:26,t:'leaf',pal:HARVEST}],
      christmas:[{n:60,t:'snow'},{n:18,t:'twinkle',pal:['#FDE68A','#EF4444','#22C55E','#FFFFFF']}]
    };
    var FALL={snow:[18,42],leaf:[28,55],petal:[16,34],confetti:[30,60],shamrock:[24,48],coin:[40,70],egg:[26,46],star:[30,58]};
    var RISE={glint:[6,16],heart:[18,38],ember:[14,34]};
    var SIZE={snow:[1.2,3.2],leaf:[5,9],petal:[3,5.5],glint:[1,2.4],confetti:[2.5,4.5],heart:[6,11],shamrock:[4,6.5],coin:[4,6],egg:[6,9],star:[3,5.5],ember:[1,2.2],twinkle:[2.4,4.2],bat:[11,18]};
    function mk(L, edge) {
      var t=L.t, p={t:t,c:L.pal?pick(L.pal):'#fff',ph:R(0,6.28),sp:R(.4,1.2),rot:R(0,6.28),vr:R(-1.6,1.6),a:R(.6,1),x:R(0,W())};
      if (FALL[t]) { p.vy=R(FALL[t][0],FALL[t][1]); p.y=edge?R(-Hh()*.2,-12):R(0,Hh()); }
      else if (RISE[t]) { p.vy=-R(RISE[t][0],RISE[t][1]); p.y=edge?R(Hh()+10,Hh()*1.2):R(0,Hh()); }
      p.sw = t==='snow'?R(8,22) : t==='glint'?R(6,14) : t==='ember'?R(6,18) : R(18,50);
      p.r = SIZE[t] ? R(SIZE[t][0],SIZE[t][1]) : 3;
      if (t==='snow') p.c='rgba(255,255,255,'+R(.35,.85)+')';
      if (t==='glint') p.c='rgba(255,224,150,'+R(.25,.6)+')';
      if (t==='petal') p.c=pick(['#F9A8D4','#F472B6','#FBCFE8','#F0ABFC','#FFE4E6']);
      if (t==='ember') p.c=pick(['#FB923C','#F97316','#FDBA74','#EA580C']);
      if (t==='twinkle') { p.y=R(0,Hh()); p.vy=0; p.sp=R(1.2,2.6); }
      if (t==='bat') { var left=Math.random()<.5; p.vx=(left?1:-1)*R(70,130); p.x=left?R(-260,-30):R(W()+30,W()+260); p.y=R(Hh()*.08,Hh()*.6); p.vy=0; p.sp=R(5,8); }
      if (t==='egg') { p.c2=pick(['#FFFFFF','#FDE68A','#F9A8D4','#A5F3FC']); p.vr=R(-.8,.8); }
      return p;
    }
    function star(r,inner){ ctx.beginPath(); for(var i=0;i<10;i++){ var rr=i%2?r*inner:r, an=-Math.PI/2+i*Math.PI/5; ctx.lineTo(Math.cos(an)*rr,Math.sin(an)*rr);} ctx.closePath(); }
    function heart(r){ ctx.beginPath(); ctx.moveTo(0,r); ctx.bezierCurveTo(-r*1.4,0,-r*.6,-r*1.2,0,-r*.4); ctx.bezierCurveTo(r*.6,-r*1.2,r*1.4,0,0,r); ctx.fill(); }
    function lobe(s){ ctx.beginPath(); ctx.moveTo(0,0); ctx.bezierCurveTo(-s*1.4,-s,-s*.6,-s*2.2,0,-s*1.4); ctx.bezierCurveTo(s*.6,-s*2.2,s*1.4,-s,0,0); ctx.fill(); }
    function drawP(p) {
      var t=p.t, g;
      if (t==='snow'){ ctx.fillStyle=p.c; ctx.beginPath(); ctx.arc(0,0,p.r,0,6.283); ctx.fill(); return; }
      if (t==='glint'||t==='ember'){ g=ctx.createRadialGradient(0,0,0,0,0,p.r*4); g.addColorStop(0,p.c); g.addColorStop(1,'rgba(0,0,0,0)'); ctx.globalAlpha=t==='ember'?(.55+.45*Math.sin(p.ph*6))*.9:1; ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,p.r*4,0,6.283); ctx.fill(); return; }
      if (t==='twinkle'){ ctx.globalAlpha=.25+.75*Math.abs(Math.sin(p.ph)); ctx.fillStyle=p.c; ctx.shadowColor=p.c; ctx.shadowBlur=8; ctx.rotate(p.ph*.2); star(p.r,.42); ctx.fill(); return; }
      if (t==='bat'){ var fl=Math.sin(p.ph), w=p.r; ctx.scale(p.vx<0?-1:1,1); ctx.fillStyle='#0A0A0C'; ctx.shadowColor='rgba(249,115,22,.55)'; ctx.shadowBlur=10;
        ctx.beginPath(); ctx.moveTo(0,0); ctx.quadraticCurveTo(-w*.5,-w*.7*fl,-w*1.3,-w*.25*fl); ctx.quadraticCurveTo(-w*.8,w*.05,-w*.55,w*.2); ctx.quadraticCurveTo(-w*.3,w*.05,0,w*.25);
        ctx.quadraticCurveTo(w*.3,w*.05,w*.55,w*.2); ctx.quadraticCurveTo(w*.8,w*.05,w*1.3,-w*.25*fl); ctx.quadraticCurveTo(w*.5,-w*.7*fl,0,0); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0,w*.05,w*.18,w*.3,0,0,6.283); ctx.fill(); return; }
      ctx.rotate(p.rot);
      if (t==='coin'){ ctx.scale(Math.abs(Math.cos(p.ph*2.2))*.85+.15,1); ctx.fillStyle='#E5B33A'; ctx.beginPath(); ctx.arc(0,0,p.r,0,6.283); ctx.fill(); ctx.strokeStyle='#FDE68A'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(0,0,p.r*.65,0,6.283); ctx.stroke(); return; }
      if (t==='star'){ ctx.globalAlpha=p.a*.9; ctx.fillStyle=p.c; star(p.r,.45); ctx.fill(); return; }
      if (t==='heart'){ ctx.globalAlpha=p.a*.8; ctx.rotate(-p.rot+Math.sin(p.ph)*.35); ctx.fillStyle=p.c; heart(p.r); return; }
      if (t==='shamrock'){ ctx.globalAlpha=p.a*.85; ctx.fillStyle=p.c; for(var i=0;i<3;i++){ ctx.save(); ctx.rotate(i*2.094); lobe(p.r*.55); ctx.restore(); } ctx.strokeStyle=p.c; ctx.lineWidth=1.4; ctx.beginPath(); ctx.moveTo(0,0); ctx.quadraticCurveTo(p.r*.3,p.r*.9,p.r*.7,p.r*1.6); ctx.stroke(); return; }
      if (t==='egg'){ ctx.rotate(-p.rot+Math.sin(p.ph)*.6); ctx.globalAlpha=p.a*.9; ctx.fillStyle=p.c; ctx.beginPath(); ctx.ellipse(0,0,p.r*.74,p.r,0,0,6.283); ctx.fill(); ctx.save(); ctx.clip(); ctx.fillStyle=p.c2; ctx.fillRect(-p.r,-p.r*.15,p.r*2,p.r*.3); ctx.restore(); ctx.fillStyle='rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(-p.r*.25,-p.r*.45,p.r*.14,0,6.283); ctx.fill(); return; }
      ctx.scale(1,Math.abs(Math.cos(p.ph*1.3))*.75+.25); ctx.globalAlpha=p.a*.85; ctx.fillStyle=p.c; ctx.beginPath();
      if (t==='leaf'){ ctx.moveTo(0,-p.r); ctx.quadraticCurveTo(p.r*.9,-p.r*.2,0,p.r); ctx.quadraticCurveTo(-p.r*.9,-p.r*.2,0,-p.r); ctx.fill(); ctx.strokeStyle='rgba(60,20,5,.45)'; ctx.lineWidth=.7; ctx.beginPath(); ctx.moveTo(0,-p.r); ctx.lineTo(0,p.r*1.25); ctx.stroke(); }
      else if (t==='confetti'){ ctx.fillRect(-p.r*.5,-p.r,p.r,p.r*2); }
      else { ctx.ellipse(0,0,p.r,p.r*.62,0,0,6.283); ctx.fill(); }
    }
    function size(){ if(!cv) return; var dpr=Math.min(2,window.devicePixelRatio||1); cv.width=innerWidth*dpr; cv.height=innerHeight*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
    function frame(now) {
      try {
        var dt=Math.min(.05,(now-last)/1000); last=now; ctx.clearRect(0,0,W(),Hh());
        for (var li=0; li<layers.length; li++) {
          var Lr=layers[li], L=Lr.L, i, p, x;
          if (L.t==='fireworks') {
            Lr.next-=dt; if(Lr.next<=0 && Lr.rockets.length<3){ Lr.next=R(.7,1.6)/L.rate; Lr.rockets.push({x:R(W()*.1,W()*.9),y:Hh()+8,vy:-R(420,560),ty:R(Hh()*.12,Hh()*.42),c:pick(L.pal)}); }
            ctx.save(); ctx.globalCompositeOperation='lighter';
            for(i=Lr.rockets.length-1;i>=0;i--){ var r=Lr.rockets[i]; r.y+=r.vy*dt; r.vy+=120*dt;
              ctx.strokeStyle='rgba(255,230,180,.7)'; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(r.x,r.y); ctx.lineTo(r.x,r.y+16); ctx.stroke();
              if(r.y<=r.ty||r.vy>-40){ var n=Math.floor(R(46,70)), c2=pick(L.pal); for(var k=0;k<n;k++){ var an=R(0,6.283), sp=R(60,200); Lr.sparks.push({x:r.x,y:r.y,vx:Math.cos(an)*sp,vy:Math.sin(an)*sp,life:R(1.2,2),max:2,c:Math.random()<.7?r.c:c2}); } Lr.rockets.splice(i,1); } }
            for(i=Lr.sparks.length-1;i>=0;i--){ var s=Lr.sparks[i]; s.life-=dt; if(s.life<=0){ Lr.sparks.splice(i,1); continue; }
              s.vx*=1-1.4*dt; s.vy*=1-1.4*dt; s.vy+=55*dt; s.x+=s.vx*dt; s.y+=s.vy*dt;
              ctx.globalAlpha=Math.min(1,s.life/s.max*1.4)*.75; ctx.fillStyle=s.c; ctx.beginPath(); ctx.arc(s.x,s.y,1.6,0,6.283); ctx.fill(); }
            ctx.restore(); continue;
          }
          for (i=0;i<Lr.ps.length;i++) { p=Lr.ps[i]; p.ph+=dt*p.sp; p.rot+=p.vr*dt;
            if (p.t==='bat') { p.x+=p.vx*dt; p.y+=Math.sin(p.ph*.35)*14*dt; x=p.x; if((p.vx>0&&p.x>W()+300)||(p.vx<0&&p.x<-300)){ Lr.ps[i]=mk(L,true); continue; } }
            else if (p.t==='twinkle') { x=p.x; }
            else { p.y+=p.vy*dt; x=p.x+Math.sin(p.ph)*p.sw; if((p.vy>0&&p.y>Hh()+24)||(p.vy<0&&p.y<-24)){ Lr.ps[i]=mk(L,true); continue; } }
            ctx.save(); ctx.translate(x,p.y); drawP(p); ctx.restore(); }
        }
        raf=requestAnimationFrame(frame);
      } catch (_) { stop(); }   // a drawing bug stops the animation, never the board
    }
    function start() {
      if (cv) return;
      if (!layers) layers=(THEMES[th.key]||[]).map(function(L){ return { L:L, ps: L.t==='fireworks'?[]:Array.from({length:L.n},function(){return mk(L,false);}), rockets:[], sparks:[], next:R(.2,1) }; });
      cv=document.createElement('canvas'); cv.className='ca-season-fx'; cv.setAttribute('aria-hidden','true');
      cv.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:35';
      document.body.appendChild(cv); ctx=cv.getContext('2d'); size();
      last=performance.now(); raf=requestAnimationFrame(frame);
    }
    addEventListener('resize', size);
    document.addEventListener('visibilitychange', sync);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();
  } catch (e) {
    try { console.warn('[seasonal] disabled:', e && e.message); } catch (_) {}
  }
})();
