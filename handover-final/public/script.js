document.querySelector('.newsletter form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.textContent = '✓';
  event.currentTarget.querySelector('input').value = '';
});

document.querySelectorAll('.product-image button').forEach((button) => {
  button.addEventListener('click', () => {
    button.textContent = button.textContent === '♡' ? '♥' : '♡';
  });
});

// First-party analytics hook. The API can aggregate these events for the private admin studio.
(() => {
  const sid = sessionStorage.getItem('almara_sid') || crypto.randomUUID();
  sessionStorage.setItem('almara_sid', sid);
  const send = (event_name, metadata = {}) => fetch('/api/analytics/events', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({event_name, path:location.pathname, session_id:sid, metadata})
  }).catch(()=>{});
  send('page_view');
  document.querySelectorAll('a[href*="#collections"]').forEach(a => a.addEventListener('click', () => send('collection_click')));
})();
