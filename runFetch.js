fetch('http://127.0.0.1:3000/api/settings/smtp-config', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ SMTP_PASS: 'nbsl bdds eobt hspa' })
})
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);
