/**
 * Feedback widget for the public pages.
 *
 * Self-contained: injects its own button and dialog, so any page can opt in
 * with a single script tag. Posts to the same endpoint the app uses, which
 * accepts anonymous feedback, because someone who bounces off the demo is
 * exactly the person worth hearing from and they will not open a mail client
 * to tell you.
 */
(function () {
  const KINDS = [
    ['bug', 'Something broke'],
    ['confusing', 'Confusing'],
    ['idea', 'Idea'],
    ['praise', 'Worked well']
  ];

  let kind = 'bug';

  const style = document.createElement('style');
  style.textContent = `
    .fb-launch {
      position: fixed; right: 22px; bottom: 22px; z-index: 200;
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--mono, monospace); font-size: 11px;
      letter-spacing: .09em; text-transform: uppercase;
      padding: 12px 18px; border-radius: 100px; cursor: pointer;
      background: var(--spark, #35e08a); color: #08120d; border: none;
      box-shadow: 0 8px 26px rgba(0,0,0,.4);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .fb-launch:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .fb-launch svg { display: block; }

    .fb-sheet {
      border: 1px solid var(--line, #1b2f24); border-radius: 6px;
      background: var(--deep, #0c1a13); color: var(--sand, #e9e3d5);
      padding: 28px; width: min(460px, calc(100vw - 32px)); max-width: 460px;
    }
    .fb-sheet::backdrop { background: rgba(4,10,7,.72); }
    .fb-sheet h2 { font-family: var(--serif, Georgia), serif; font-weight: 400; font-size: 27px; margin: 0 0 8px; }
    .fb-sheet .fb-dek { font-size: 14px; line-height: 1.55; color: var(--mute, #75887c); margin: 0 0 20px; }
    .fb-sheet label {
      display: block; font-family: var(--mono, monospace); font-size: 10px;
      letter-spacing: .12em; text-transform: uppercase; color: var(--mute, #75887c); margin-bottom: 7px;
    }
    .fb-field { margin-bottom: 16px; }
    .fb-kinds { display: flex; flex-wrap: wrap; gap: 6px; }
    .fb-kind {
      font-family: var(--mono, monospace); font-size: 11px; padding: 8px 12px; cursor: pointer;
      border: 1px solid var(--line, #1b2f24); border-radius: 3px;
      background: var(--deeper, #08120d); color: var(--sand-2, #b9c4bb);
    }
    .fb-kind.on { background: var(--spark, #35e08a); border-color: var(--spark, #35e08a); color: #08120d; }
    .fb-sheet textarea, .fb-sheet input {
      width: 100%; font-family: inherit; font-size: 14.5px; padding: 11px 13px;
      border: 1px solid var(--line, #1b2f24); border-radius: 3px;
      background: var(--deeper, #08120d); color: var(--sand, #e9e3d5); resize: vertical;
    }
    .fb-sheet textarea:focus-visible, .fb-sheet input:focus-visible { outline: 2px solid var(--spark, #35e08a); outline-offset: 1px; }
    .fb-foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .fb-btn {
      font-family: var(--mono, monospace); font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
      padding: 11px 18px; border-radius: 3px; cursor: pointer; border: 1px solid var(--spark, #35e08a);
      background: var(--spark, #35e08a); color: #08120d;
    }
    .fb-btn.ghost { background: none; color: var(--sand-2, #b9c4bb); border-color: var(--line, #1b2f24); }
    .fb-msg { font-size: 12.5px; color: var(--alert, #e07a5f); margin: 0; flex: 1; }
    .fb-thanks { text-align: center; padding: 12px 0 4px; }
    @media (max-width: 560px) { .fb-launch { right: 14px; bottom: 14px; padding: 10px 14px; } }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'fb-launch';
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3.2h12v8H6.6L3.4 13.6V11.2H2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>Feedback`;
  document.body.appendChild(btn);

  const dialog = document.createElement('dialog');
  dialog.className = 'fb-sheet';
  dialog.innerHTML = `
    <h2>What would you change?</h2>
    <p class="fb-dek">Cited is in beta and a person reads every one of these. We will attach which page you were on, so you do not have to explain.</p>

    <div class="fb-field">
      <label>What kind of thing is it</label>
      <div class="fb-kinds">
        ${KINDS.map(([k, l], i) => `<button type="button" class="fb-kind ${i === 0 ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="fb-field">
      <label for="fbText">Tell us</label>
      <textarea id="fbText" rows="5" placeholder="What happened, or what you expected instead"></textarea>
    </div>

    <div class="fb-field">
      <label for="fbMail">Email, if you want a reply</label>
      <input id="fbMail" type="email" placeholder="Optional" />
    </div>

    <div class="fb-foot">
      <p class="fb-msg" role="alert"></p>
      <button type="button" class="fb-btn ghost" data-close>Cancel</button>
      <button type="button" class="fb-btn" data-send>Send</button>
    </div>`;
  document.body.appendChild(dialog);

  const $ = (sel) => dialog.querySelector(sel);
  const msg = $('.fb-msg');

  btn.addEventListener('click', () => {
    msg.textContent = '';
    dialog.showModal();
    $('#fbText').focus();
  });

  dialog.addEventListener('click', (e) => {
    const k = e.target.closest('.fb-kind');
    if (k) {
      kind = k.dataset.k;
      dialog.querySelectorAll('.fb-kind').forEach((b) => b.classList.toggle('on', b === k));
      return;
    }
    if (e.target.closest('[data-close]')) dialog.close();
  });

  $('[data-send]').addEventListener('click', async (e) => {
    const text = $('#fbText').value.trim();
    if (text.length < 4) {
      msg.textContent = 'Tell us a little more than that.';
      return;
    }

    e.target.disabled = true;
    e.target.textContent = 'Sending';

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          message: text,
          email: $('#fbMail').value.trim(),
          view: document.title.split('|')[0].trim(),
          path: location.pathname + location.search,
          viewport: `${window.innerWidth}x${window.innerHeight}`
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not send that');

      dialog.innerHTML = `<div class="fb-thanks">
          <h2>Thank you</h2>
          <p class="fb-dek" style="margin:0 auto 18px;max-width:38ch">Read by a person, not a queue. If you left an email we will come back to you.</p>
          <button type="button" class="fb-btn" data-close>Close</button>
        </div>`;
      dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
      setTimeout(() => dialog.close(), 2800);
    } catch (err) {
      msg.textContent = err.message;
      e.target.disabled = false;
      e.target.textContent = 'Send';
    }
  });
})();
