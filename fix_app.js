const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const loaderCode = `
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Reveal observer logic
    const observerCallback = (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
        }
      });
    };

    const observerOptions = {
      root: null,
      rootMargin: "0px",
      threshold: 0.1,
    };

    const observer = new IntersectionObserver(observerCallback, observerOptions);
    
    // Timeout for DOM to paint completely
    setTimeout(() => {
        const revealElements = document.querySelectorAll(
          ".reveal, .reveal-left, .reveal-scale, .reveal-grid"
        );
        revealElements.forEach((el) => observer.observe(el));
    }, 100);

    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 1500);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
`;

code = code.replace(/const \[termsAccepted, setTermsAccepted\] = useState\(false\);\n  const \[showTerms, setShowTerms\] = useState\(false\);\n  const \[pendingAction, setPendingAction\] = useState<\(\(\)\ => void\) \| null>\(null\);\n\n  useEffect\(\(\) => \{\n    const accepted = localStorage\.getItem\("hasAcceptedTerms"\) === "true";\n    setTermsAccepted\(accepted\);\n  \}, \[\]\);/m, 
`const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  useEffect(() => {
    const accepted = localStorage.getItem("hasAcceptedTerms") === "true";
    setTermsAccepted(accepted);
  }, []);

` + loaderCode);

// Add AnimatePresence and motion back
code = code.replace(/<TermsPopup/g, `
      <AnimatePresence>
        {isLoading && (
          <motion.div
            key="preloader"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
            className="fixed inset-0 z-[9999] bg-cream flex flex-col items-center justify-center overflow-hidden"
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 100, damping: 20, mass: 1 }}
              className="relative"
            >
              <div className="absolute inset-0 border-4 border-electric/30 rounded-full animate-ping"></div>
              <div className="w-20 h-20 bg-navy rounded-full flex items-center justify-center text-white font-serif text-3xl font-bold shadow-2xl z-10 relative">
                R
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 100, damping: 20 }}
              className="mt-6 text-navy font-medium tracking-widest text-sm uppercase"
            >
              Loading Experience
            </motion.div>
            <motion.div
              className="h-1 bg-electric w-0 absolute bottom-0 left-0"
              animate={{ width: "100%" }}
              transition={{ duration: 1.5, ease: "easeInOut" }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <TermsPopup`);

fs.writeFileSync('src/App.tsx', code);
