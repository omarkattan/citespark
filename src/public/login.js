(() => {
  let mode='login',busy=false;
  const $=id=>document.getElementById(id),panel=$('panel');
  const escapeHtml=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label=()=>mode==='login'?'Sign in':'Create account';
  $('toggle').addEventListener('click',e=>{
    e.preventDefault();if(busy)return;
    mode=mode==='login'?'register':'login';
    $('formTitle').textContent=mode==='login'?'Sign in':'Create an account';
    document.title=`${$('formTitle').textContent} | Cited`;
    $('submit').textContent=label();$('toggle').textContent=mode==='login'?'Create an account instead':'Sign in instead';
    $('orgField').hidden=mode==='login';$('passwordHint').hidden=mode==='login';
    $('password').autocomplete=mode==='login'?'current-password':'new-password';
    if(mode==='register')$('password').minLength=8;else $('password').removeAttribute('minlength');
    $('error').textContent='';$('error').className='error';
  });
  $('showPassword').addEventListener('click',()=>{
    const shown=$('password').type==='password';$('password').type=shown?'text':'password';
    $('showPassword').textContent=shown?'Hide password':'Show password';$('showPassword').setAttribute('aria-pressed',String(shown));
  });
  if(new URLSearchParams(location.search).get('signup')==='1')$('toggle').click();
  const demoHint=window.CitedDemoHandoff?.read();
  if(new URLSearchParams(location.search).get('demo')==='1'&&demoHint){
    $('orgName').value=demoHint.site.brandName||'';const hint=document.createElement('p');
    hint.textContent=`Continue setting up ${demoHint.site.domain}. Your demo notes remain available in this browser for 24 hours.`;panel.prepend(hint);
  }
  async function post(path,body){
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw Error('We could not complete that request. Please try again.');}
    if(!response.ok)throw Error(data.error||'Please try again.');return data;
  }
  document.addEventListener('click',async e=>{
    if(e.target.id==='resend'){
      e.target.disabled=true;
      try{const result=await post('/api/verify/resend');$('resendMsg').textContent=result.alreadyVerified?'Your email is confirmed. Continue setting up your site.':'Confirmation requested. Check your inbox and spam folder.';}
      catch(error){$('resendMsg').textContent=error.message||'Could not resend. Please try again.';}
      finally{e.target.disabled=false;}
    }
    if(e.target.id==='forgot'){
      e.preventDefault();if(busy)return;
      if(!$('email').reportValidity())return;
      const email=$('email').value.trim();busy=true;
      try{await post('/api/password/forgot',{email});$('error').className='note';$('error').textContent=`If ${email} has an account, a reset link is on its way. It works for one hour.`;}
      catch(error){$('error').className='error';$('error').textContent=error.message||'Could not request a reset. Please try again.';}
      finally{busy=false;}
    }
  });
  panel.addEventListener('submit',async e=>{
    e.preventDefault();if(busy||!$('email')||!panel.reportValidity())return;
    busy=true;$('error').textContent='';$('error').className='error';$('submit').disabled=true;$('submit').textContent=mode==='login'?'Signing in…':'Creating your account…';
    try{
      const email=$('email').value.trim();
      const data=await post(`/api/${mode}`,{email,password:$('password').value,orgName:$('orgName').value.trim()});
      if(data.verificationSent){
        panel.innerHTML=`<h2>Check your email</h2><p class="sent-to">We sent a confirmation link to <b>${escapeHtml(email)}</b>.</p><p class="sent-note">You can add your website and review suggested questions now. Confirm your email before running your first measurement. The link works for two days.</p><div class="sent-actions"><a class="btn" href="/app">Next: add your website</a><button type="button" class="ghost" id="resend">Send it again</button></div><p class="sent-hint" id="resendMsg" role="status">Not arrived? Check spam, or request another link.</p>`;
        busy=false;return;
      }
      window.location.href='/app';
    }catch(error){$('error').textContent=error.message||'We could not connect. Please try again.';$('submit').disabled=false;$('submit').textContent=label();busy=false;}
  });
})();
