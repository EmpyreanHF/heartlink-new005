/* =====================================================================================================
   MATCHMAKING ADMIN (a section you can drop into your existing admin portal, or use alone through matchmaking-admin.html)
   In the admin portal page, add where you want the section to appear:
        <div id="mmAdmin"></div>
        <script src="matchmaking-admin.js"></script>
   It signs in with the same ADMIN_SECRET and the same saved login (sessionStorage 'flc_adm') as moderation.html.
   Everything is scoped under .mma and mma_ ids, so it cannot clash with the portal's own styles or element ids.
   ===================================================================================================== */
(function () {
  'use strict';
  const CSS = `.mma{--bg:#fff7fb;--card:#fff;--ink:#3b0a24;--mute:#6b7280;--pink:#be185d;--line:#fbcfe8;--ok:#047857;--bad:#b91c1c;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border-radius:14px;padding:14px;max-width:760px;margin:0 auto;text-align:left}
@media (prefers-color-scheme:dark){.mma{--bg:#1a0f16;--card:#26141f;--ink:#fde7f3;--mute:#c9a3b8;--pink:#f9a8d4;--line:#4a2438;--ok:#6ee7b7;--bad:#fca5a5}}
.mma *{box-sizing:border-box}.mma h1{font-size:22px;margin:4px 0 2px;font-weight:700}.mma h2{font-size:17px;margin:26px 0 8px;color:var(--pink);font-weight:700}
.mma .mute{color:var(--mute);font-size:13px}.mma .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:10px 0}
.mma .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.mma .g2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}@media(max-width:520px){.mma .g2{grid-template-columns:1fr}}
.mma button,.mma input,.mma textarea,.mma select{font:inherit;border-radius:10px;border:1px solid var(--line);padding:9px 12px;background:var(--card);color:var(--ink);width:100%;min-height:44px}
.mma button{cursor:pointer;font-weight:600;width:auto}.mma button.p{background:var(--pink);border-color:var(--pink);color:#fff}.mma button.d{color:var(--bad);border-color:var(--bad)}
.mma button:focus-visible,.mma input:focus-visible,.mma textarea:focus-visible,.mma select:focus-visible{outline:2px solid var(--pink);outline-offset:2px}
.mma label{display:block;font-size:13px;font-weight:700;margin:10px 0 4px}.mma textarea{resize:none}.mma .tag{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:1px 9px;border:1px solid var(--line);margin-right:4px}
.mma .pic{width:56px;height:56px;min-height:0;border-radius:12px;object-fit:cover;background:var(--line);flex:none}.mma .who{display:flex;gap:12px;align-items:center}
.mma #mma_err{color:var(--bad);min-height:20px}.mma .empty{color:var(--mute);padding:8px 0}.mma .chk{display:flex;gap:10px;align-items:flex-start;margin-top:14px}.mma .chk input{width:22px;min-height:22px;margin-top:2px;flex:none}`;
  const MARKUP = `
<h1>Matchmaking profiles</h1><p class="mute">Post real men and women who agreed to be listed. Members see them in Browse and the match queue, marked "Posted by Heart Link matchmaker". When a member taps Express interest, it appears under "Interest from members" for you to follow up. Do not post made-up people.</p>
<h2 id="mma_ftitle">Add a profile</h2>
<div class="card"><div class="who"><img id="mma_pv" class="pic" alt="" hidden><div style="flex:1"><label for="mma_photo" style="margin-top:0">Photo of the person (required)</label><input id="mma_photo" type="file" accept="image/*"><div class="mute" id="mma_pst"></div></div></div>
<div class="g2"><div><label for="mma_name">Name</label><input id="mma_name" maxlength="60"></div><div><label for="mma_gender">Gender</label><select id="mma_gender"><option value="female">Woman</option><option value="male">Man</option></select></div>
<div><label for="mma_age">Age (18+)</label><input id="mma_age" type="number" min="18" max="90"></div><div><label for="mma_city">City</label><input id="mma_city" maxlength="60"></div>
<div><label for="mma_religion">Religion</label><select id="mma_religion"><option>Christian</option><option>Muslim</option><option>Other</option></select></div><div><label for="mma_job">Profession</label><input id="mma_job" maxlength="80"></div></div>
<label for="mma_intent">Looking for</label><select id="mma_intent"><option value="marriage">Marriage</option><option value="serious_relationship" selected>Serious relationship leading to marriage</option><option value="friendship_to_marriage">Friendship that will lead to marriage</option></select>
<label for="mma_bio">Bio</label><textarea id="mma_bio" rows="3" maxlength="300"></textarea>
<div class="g2"><div><label for="mma_lo">Partner min age</label><input id="mma_lo" type="number" value="24"></div><div><label for="mma_hi">Partner max age</label><input id="mma_hi" type="number" value="35"></div>
<div><label for="mma_pc">Partner city (Any for anywhere)</label><input id="mma_pc" value="Any" maxlength="60"></div><div><label for="mma_pr">Partner religion</label><select id="mma_pr"><option>Any</option><option>Christian</option><option>Muslim</option><option>Other</option></select></div></div>
<label for="mma_q">Qualities wanted</label><input id="mma_q" maxlength="200">
<label for="mma_phone">Phone / WhatsApp to release after they approve (members never see it before)</label><input id="mma_phone" maxlength="24" inputmode="tel">
<label for="mma_contact">Private notes (only you see this)</label><input id="mma_contact" maxlength="300">
<label class="chk"><input type="checkbox" id="mma_consent"><span>This is a real person. They are 18 or older and agreed to be listed on Heart Link.</span></label>
<div class="row"><button class="p" id="mma_save">Save profile</button><button id="mma_clear">Clear form</button></div></div>
<h2>Interest from members</h2><div id="mma_leads"></div>
<h2>Posted profiles</h2><div id="mma_list"></div>
`;
  function mount(root) {
    if (!document.getElementById('mmaCss')) { const s = document.createElement('style'); s.id = 'mmaCss'; s.textContent = CSS; document.head.appendChild(s); }
    root.classList.add('mma');
    root.innerHTML = '<div id="mma_login" style="max-width:380px;margin:20px auto"><h1>Matchmaking profiles</h1><p class="mute">Enter the admin secret (the same ADMIN_SECRET as the rest of admin).</p><input id="mma_sec" type="password" autocomplete="current-password" placeholder="Admin secret" aria-label="Admin secret"><div class="row"><button class="p" id="mma_go">Open</button></div><p id="mma_err"></p></div><div id="mma_app" hidden>' + MARKUP + '</div>';
    const $=id=>root.querySelector('#mma_'+id);
    const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let SECRET=sessionStorage.getItem('flc_adm')||'', PHOTO='', EDIT='', LIST=[], LEADS=[];
    const CLOUD='mi7osvee', PRESET='ml_default';      // the same unsigned upload preset the app uses
    const when=t=>t?new Date(t).toLocaleString():'';
    async function call(path,method,body){
      const r=await fetch(path,{method:method||'GET',headers:{'x-admin-secret':SECRET,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
      const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||('Error '+r.status)); return j;
    }
    function shrink(file){return new Promise((ok,no)=>{const im=new Image(),u=URL.createObjectURL(file);im.onload=()=>{const m=Math.min(1,1000/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*m);c.height=Math.round(im.height*m);c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(b=>b?ok(b):no(new Error('Could not read the photo')),'image/jpeg',.85)};im.onerror=()=>no(new Error('Could not read the photo'));im.src=u})}
    $('photo').onchange=async e=>{const f=e.target.files[0];if(!f)return;$('pst').textContent='Uploading...';
      try{const b=await shrink(f),fd=new FormData();fd.append('file',b);fd.append('upload_preset',PRESET);fd.append('folder','matchmaking');
        const r=await fetch('https://api.cloudinary.com/v1_1/'+CLOUD+'/image/upload',{method:'POST',body:fd}),j=await r.json();if(!j.secure_url)throw new Error('Upload failed');
        PHOTO=j.secure_url;$('pv').src=PHOTO;$('pv').hidden=false;$('pst').textContent='Photo ready'}catch(x){$('pst').textContent=x.message}};
    function clearForm(){EDIT='';PHOTO='';$('pv').hidden=true;$('pst').textContent='';$('ftitle').textContent='Add a profile';['name','age','city','job','bio','q','contact','phone'].forEach(i=>$(i).value='');$('lo').value=24;$('hi').value=35;$('pc').value='Any';$('pr').value='Any';$('consent').checked=false;$('photo').value=''}
    $('clear').onclick=clearForm;
    $('save').onclick=async()=>{const b=$('save');b.disabled=true;
      try{await call('/admin/mm/profile','POST',{id:EDIT||undefined,photo:PHOTO,name:$('name').value,gender:$('gender').value,age:$('age').value,city:$('city').value,religion:$('religion').value,job:$('job').value,intent:$('intent').value,bio:$('bio').value,prefMinAge:$('lo').value,prefMaxAge:$('hi').value,prefCity:$('pc').value,prefReligion:$('pr').value,qualities:$('q').value,contact:$('contact').value,phone:$('phone').value,consent:$('consent').checked});
        alert('Saved');clearForm();load()}catch(e){alert(e.message)}b.disabled=false};
    async function load(){
      try{
        const [p,l]=await Promise.all([call('/admin/mm/profiles'),call('/admin/mm/leads')]);sessionStorage.setItem('flc_adm',SECRET);$('login').hidden=true;$('app').hidden=false;LIST=p.profiles;
        LEADS=l.leads;
        const ST={open:'New',forwarded:'Waiting for approval',approved:'Approved'};
        $('leads').innerHTML=LEADS.length?LEADS.map((x,i)=>{const m=x.member,btn=(a,t,c)=>`<button class="${c||''}" data-a="${a}" data-i="${i}">${t}</button>`;
          return `<div class="card"><div class="who"><img class="pic" src="${esc(m.photo)}" alt=""><div><b>${esc(m.name||'Member')}</b> is interested in <b>${esc(x.profile.name)}</b> <span class="tag">${ST[x.status]}</span><div class="mute">${esc(m.age)} · ${esc(m.city)} · ${esc(m.religion)} · ${esc(m.job)} · ${when(x.at)}</div></div></div>
          <p class="mute">Member phone (do not share until ${esc(x.profile.name)} approves): <b>${esc(m.phone||'not given')}</b></p>
          <div class="row">${x.status==='open'?btn('fwd','Forward to '+esc(x.profile.name)+' for approval','p')+btn('decl','Decline'):''}${x.status==='forwarded'?btn('appr','She approved','p')+btn('decl','She declined'):''}${x.status==='approved'?btn('rel','Release her number to the member','p'):''}${btn('close','Close')}</div></div>`}).join(''):'<div class="empty">No introductions waiting.</div>';
        $('list').innerHTML=LIST.length?LIST.map((x,i)=>`<div class="card"><div class="who"><img class="pic" src="${esc(x.photo)}" alt=""><div><b>${esc(x.name)}, ${esc(x.age)}</b> <span class="tag">${x.gender==='male'?'Man':'Woman'}</span><span class="tag">${x.linkedUid?'Joined: on own account':x.active===false?'Hidden':'Showing'}</span><div class="mute">${esc(x.city)} · ${esc(x.religion)}</div></div></div><div class="row">${x.linkedUid?'':`<button data-a="edit" data-i="${i}">Edit</button><button data-a="toggle" data-i="${i}">${x.active===false?'Show to members':'Hide'}</button><button data-a="code" data-i="${i}">Send claim code</button>`}<button class="d" data-a="del" data-i="${i}">Delete</button></div></div>`).join(''):'<div class="empty">Nothing posted yet.</div>';
      }catch(e){$('err').textContent=e.message;if(!$('app').hidden)alert(e.message);else{$('login').hidden=false;sessionStorage.removeItem('flc_adm')}}
    }
    const LBL={intent:{marriage:'Marriage',serious_relationship:'A serious relationship leading to marriage',friendship_to_marriage:'Friendship that will lead to marriage'}};
    function fwdText(x){const m=x.member;return `Hello ${x.profile.name}, someone on Heart Link matchmaking would like to be introduced to you.\n\n${m.name}, ${m.age}\n${m.city} · ${m.religion}${m.job?' · '+m.job:''}\nLooking for: ${LBL.intent[m.intent]||'a serious relationship'}\n${m.bio?'About: '+m.bio+'\n':''}${m.qualities?'Wants: '+m.qualities+'\n':''}${m.photo?'Photo: '+m.photo+'\n':''}\nDo you agree to be introduced? Reply YES or NO. Your number is not shared unless you say yes.`}
    function waLink(phone,text){let d=String(phone||'').replace(/\D/g,'');if(d.length===11&&d[0]==='0')d='234'+d.slice(1);return d.length>=10?'https://wa.me/'+d+'?text='+encodeURIComponent(text):''}
    async function setSt(id,status){await call('/admin/mm/lead/status','POST',{id,status})}
    root.addEventListener('click',async e=>{const b=e.target.closest('button[data-a]');if(!b)return;const a=b.dataset.a,x=LIST[+b.dataset.i],ld=LEADS[+b.dataset.i];
      try{
        if(a==='edit'){EDIT=x.id;PHOTO=x.photo;$('pv').src=PHOTO;$('pv').hidden=false;$('pst').textContent='Photo ready';$('ftitle').textContent='Edit '+x.name;
          Object.entries({name:x.name,gender:x.gender,age:x.age,city:x.city,religion:x.religion,job:x.job,intent:x.intent,bio:x.bio,lo:x.prefMinAge,hi:x.prefMaxAge,pc:x.prefCity,pr:x.prefReligion,q:x.qualities,contact:x.contact,phone:x.phone}).forEach(([k,v])=>$(k).value=v==null?'':v);
          $('consent').checked=false;window.scrollTo(0,0);return}
        if(a==='fwd'){const t=fwdText(ld),w=waLink(ld.profile.phone,t);try{await navigator.clipboard.writeText(t)}catch{}if(w)window.open(w,'_blank');else alert('Message copied. Send it to '+ld.profile.name+' yourself.');await setSt(ld.id,'forwarded');load();return}
        if(a==='code'){b.disabled=true;const rr=await call('/admin/mm/profile/claimcode','POST',{id:x.id});const t='Hello '+x.name+', you can now manage your own Heart Link matchmaking listing. Create or open your Heart Link account, tap Match, and enter this code: '+rr.code+'. The code works once.';try{await navigator.clipboard.writeText(t)}catch{}const w=waLink(x.phone,t);if(w)window.open(w,'_blank');else alert('Code '+rr.code+' (message copied). Send it to '+x.name+'.');b.disabled=false;return}
        b.disabled=true;
        if(a==='toggle')await call('/admin/mm/profile/toggle','POST',{id:x.id,active:x.active===false});
        if(a==='del'){if(!confirm('Delete '+x.name+'? Members will no longer see this profile.')){b.disabled=false;return}await call('/admin/mm/profile/delete','POST',{id:x.id})}
        if(a==='appr')await setSt(ld.id,'approved');
        if(a==='decl'){if(!confirm('Decline this introduction? The member will be told '+ld.profile.name+' is not available.')){b.disabled=false;return}await setSt(ld.id,'declined')}
        if(a==='rel'){if(!confirm('Release '+ld.profile.name+"'s number to "+ld.member.name+'? Only do this after she said yes.')){b.disabled=false;return}await setSt(ld.id,'released')}
        if(a==='close')await setSt(ld.id,'closed');
        load()}catch(err){alert(err.message);b.disabled=false}});
    $('go').onclick=()=>{SECRET=$('sec').value.trim();$('err').textContent='';load()};
    $('sec').addEventListener('keydown',e=>{if(e.key==='Enter')$('go').click()});
    if(SECRET)load();
  }
  window.mmAdminMount = mount;
  const auto = document.getElementById('mmAdmin'); if (auto) mount(auto);
})();