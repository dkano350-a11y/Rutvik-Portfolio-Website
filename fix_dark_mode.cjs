const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(fullPath));
        } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
            results.push(fullPath);
        }
    });
    return results;
}

const files = walk('./src');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Convert static classes to dark-mode responsive classes
    content = content.replace(/bg-cream/g, 'bg-cream dark:bg-[#090e17]');
    content = content.replace(/bg-white/g, 'bg-white dark:bg-[#111827]');
    
    // For navy text
    content = content.replace(/text-navy/g, 'text-navy dark:text-[#60a5fa]');
    content = content.replace(/text-navy\/([0-9]+)/g, 'text-navy/$1 dark:text-[#60a5fa]/$1');
    
    // For charcoal text
    content = content.replace(/text-charcoal/g, 'text-charcoal dark:text-slate-200');
    content = content.replace(/text-charcoal\/([0-9]+)/g, 'text-charcoal/$1 dark:text-slate-200/$1');
    
    // For borders
    content = content.replace(/border-navy\/([0-9]+)/g, 'border-navy/$1 dark:border-[#1e293b]');
    content = content.replace(/border-navy(?![\w\-\/])/g, 'border-navy dark:border-[#1e293b]');
    content = content.replace(/border-black\/([0-9]+)/g, 'border-black/$1 dark:border-white/10');
    
    // For accents
    content = content.replace(/shadow-black\/([0-9]+)/g, 'shadow-black/$1 dark:shadow-white/5');
    
    // Write back
    fs.writeFileSync(file, content, 'utf8');
});

console.log('Done matching dark mode classes.');
