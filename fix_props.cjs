const fs = require('fs');
const path = require('path');
const dir = 'src/components';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.tsx'));
files.forEach(f => {
  const p = path.join(dir, f);
  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace(/\s*(initial|animate|whileInView|viewport|transition|exit|layoutId|variants|whileHover)=\{.*?\}/g, '');
  // also fix if they got truncated, e.g. layoutId={`project-${title}`
  content = content.replace(/layoutId=\{[^}]+\}/g, '');
  content = content.replace(/layoutId=\{[^\n]+\n/g, '\n');
  content = content.replace(/layoutId=\{`[^`]+`/g, '');
  fs.writeFileSync(p, content);
});
