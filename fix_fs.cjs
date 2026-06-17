const fs = require('fs');

const file = 'src/components/FeaturedSkill.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/<Layers size=\{18\} \/> className="text-electric" \/>/, '<Layers size={18} className="text-electric" \/>');
content = content.replace(/<Wand2 size=\{18\} \/> className="text-electric" \/>/, '<Wand2 size={18} className="text-electric" \/>');
content = content.replace(/<MessageSquare size=\{18\} \/> className="text-electric" \/>/, '<MessageSquare size={18} className="text-electric" \/>');
content = content.replace(/<Check size=\{18\} \/> className="text-green-400" \/>/, '<Check size={18} className="text-green-400" \/>');
content = content.replace(/<Wand2 size=\{18\} \/> className="text-white\/80" \/>/, '<Wand2 size={18} className="text-white\/80" \/>');
content = content.replace(/<Sparkles size=\{18\} \/> className="group-hover:animate-pulse" \/>/, '<Sparkles size={18} className="group-hover:animate-pulse" \/>');
content = content.replace(/<ArrowRight size=\{18\} \/> className="text-electric" \/>/, '<ArrowRight size={18} className="text-electric" \/>');

content = content.replace(/key=\{idx\n/g, 'key={idx}\n');
content = content.replace(/onClick=\{\}/g, 'onClick={() => {}}');
content = content.replace(/onSubmit=\{\}/g, 'onSubmit={(e) => e.preventDefault()}');

content = content.replace(/value=\{userPrompt\n/g, 'value={userPrompt}\n');
content = content.replace(/disabled=\{\!userPrompt.trim\(\) \|\| isGenerating className=/g, 'disabled={!userPrompt.trim() || isGenerating} className=');

content = content.replace(/<div  >/g, '<div>');
fs.writeFileSync(file, content);
