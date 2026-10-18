/* First-party milestones only. No third-party scripts or email addresses in events. */
(() => {
  const seen=new Set();
  function pricing(surface){
    if(seen.has(surface))return;seen.add(surface);
    fetch('/api/conversion/pricing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({surface}),keepalive:true}).catch(()=>{});
  }
  window.CitedConversion={pricing};
  const section=document.getElementById('pricing');
  if(section&&'IntersectionObserver' in window){
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){pricing('landing');observer.disconnect();}},{threshold:0.15});
    observer.observe(section);
  }
})();
