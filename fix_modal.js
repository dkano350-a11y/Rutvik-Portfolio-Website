import fs from 'fs';

let content = fs.readFileSync('src/components/ResumeModal.tsx', 'utf8');

content = content.replace(
  /initial=\{\{\s*opacity:\s*0\}\}\n\s*animate=\{\{\s*opacity:\s*1\}\}\n\s*exit=\{\{\s*opacity:\s*0\}\}\n\s*className="fixed inset-0 z-\[100\] flex items-center justify-center p-4 sm:p-6 md:p-8 bg-navy\/80 backdrop-blur-md"\n\s*onClick=\{onClose\}\n\s*>\n\s*<motion.div\n\s*initial=\{\{\s*opacity:\s*0,\s*scale:\s*0.95,\s*y:\s*35\}\}\n\s*animate=\{\{\s*opacity:\s*1,\s*scale:\s*1,\s*y:\s*0\}\}\n\s*exit=\{\{\s*opacity:\s*0,\s*scale:\s*0.95,\s*y:\s*35\}\}\n\s*onClick=\{\(e\) => e.stopPropagation\(\)\}/,
  'initial={{ opacity: 0 }}\n  animate={{ opacity: 1 }}\n  exit={{ opacity: 0 }}\n  transition={{ duration: 0.3, ease: "easeInOut" }}\n  className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 md:p-8 bg-navy/80 backdrop-blur-md"\n  onClick={onClose}\n  >\n  <motion.div\n  initial={{ opacity: 0, scale: 0.98, y: 15 }}\n  animate={{ opacity: 1, scale: 1, y: 0 }}\n  exit={{ opacity: 0, scale: 0.98, y: 15 }}\n  transition={{ type: "spring", damping: 25, stiffness: 300 }}\n  onClick={(e) => e.stopPropagation()}'
);

fs.writeFileSync('src/components/ResumeModal.tsx', content);
console.log('Modal updated');
