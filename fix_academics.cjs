const fs = require('fs');
let file = 'src/components/Academics.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/<BookOpen size=\{18\} \/> className="text-electric" \/>/, '<BookOpen size={18} className="text-electric" \/>');
content = content.replace(/<Database size=\{18\} \/> className="text-purple-500" \/>/, '<Database size={18} className="text-purple-500" \/>');
content = content.replace(/<Presentation size=\{18\} \/> className="text-emerald-500" \/>/, '<Presentation size={18} className="text-emerald-500" \/>');
content = content.replace(/<Target size=\{18\} \/> className="text-orange-500" \/>/, '<Target size={18} className="text-orange-500" \/>');

content = content.replace(/<div, show: \{ opacity: 1, transition: \{ staggerChildren: 0\.2 \}, , initial="hidden" whileInView="show" className="relative border-l-2 border-navy\/10 ml-4 md:ml-12 pb-8" >/g, '<div className="reveal-grid relative border-l-2 border-navy\/10 ml-4 md:ml-12 pb-8">');

content = content.replace(/<div key=\{i\}, show: \{ opacity: 1, x: 0, transition: \{ type: "spring", stiffness: 60, damping: 15 \}, , className="mb-12 relative pl-8 md:pl-12" >/g, '<div key={i} className="mb-12 relative pl-8 md:pl-12">');

content = content.replace(/className=\{`absolute -left-\[17px\] top-1 w-8 h-8 rounded-full bg-white border-4 \$\{sem.color flex items-center justify-center shadow-sm`>/g, 'className={}>');

fs.writeFileSync(file, content);
