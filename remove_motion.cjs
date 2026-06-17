const fs = require('fs');
const path = require('path');

const componentsDir = 'src/components';
const files = fs.readdirSync(componentsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(componentsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Remove motion imports
  content = content.replace(/import\s+\{?[^}]*\}?\s+from\s+["']motion\/react["'];?\n?/g, '');
  content = content.replace(/import\s+\{?[^}]*\}?\s+from\s+["']framer-motion["'];?\n?/g, '');

  content = content.replace(/<motion\.div[^>]*>/g, (match) => {
    // Remove motion props
    let cleaned = match.replace(/initial=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/animate=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/whileInView=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/viewport=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/transition=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/exit=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/<motion\.div/g, '<div');
    // clean multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ');
    return cleaned;
  });
  content = content.replace(/<\/motion\.div>/g, '</div>');
  
  content = content.replace(/<motion\.h[1-6][^>]*>/g, (match) => {
    let cleaned = match.replace(/(initial|animate|whileInView|viewport|transition|exit)=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/<motion\./g, '<');
    return cleaned.replace(/\s+/g, ' ');
  });
  content = content.replace(/<\/motion\.h[1-6]>/g, (match) => match.replace('motion.', ''));

  content = content.replace(/<motion\.p[^>]*>/g, (match) => {
    let cleaned = match.replace(/(initial|animate|whileInView|viewport|transition|exit)=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/<motion\./g, '<');
    return cleaned.replace(/\s+/g, ' ');
  });
  content = content.replace(/<\/motion\.p>/g, '</p>');
  
  content = content.replace(/<motion\.span[^>]*>/g, (match) => {
    let cleaned = match.replace(/(initial|animate|whileInView|viewport|transition|exit)=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/<motion\./g, '<');
    return cleaned.replace(/\s+/g, ' ');
  });
  content = content.replace(/<\/motion\.span>/g, '</span>');

  content = content.replace(/<motion\.img[^>]*>/g, (match) => {
    let cleaned = match.replace(/(initial|animate|whileInView|viewport|transition|exit)=\{[^}]+\}/g, '');
    cleaned = cleaned.replace(/<motion\./g, '<');
    return cleaned.replace(/\s+/g, ' ');
  });
  
  content = content.replace(/<AnimatePresence[^>]*>|<\/AnimatePresence>/g, '');

  fs.writeFileSync(filePath, content);
}
console.log('Removed framer-motion');
