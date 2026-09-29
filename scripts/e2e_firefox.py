# /// script
# requires-python = ">=3.10"
# dependencies = ["selenium>=4.25"]
# ///
# Usage: uv run scripts/e2e_firefox.py [query or Scholar URL]   (Selenium downloads geckodriver on first run)
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
url = sys.argv[1] if len(sys.argv) > 1 else "https://scholar.google.com/scholar?hl=en&q=attention+is+all+you+need"

opts = Options()
opts.add_argument("-headless")
opts.set_preference("extensions.webextensions.remote", True)
d = webdriver.Firefox(options=opts)
try:
    ext_id = d.install_addon(EXT, temporary=True)
    print("installed:", ext_id)
    d.get(url)
    time.sleep(4)
    print("title:", d.title)
    for i in range(70):
        st = d.execute_script("""
          return {waiting: document.querySelectorAll('.jq-wait').length,
                  badges: document.querySelectorAll('.jq-badges').length,
                  rows: document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or, tr.gsc_a_tr').length};""")
        if st["badges"] and st["waiting"] == 0 and i > 2:
            break
        time.sleep(1)
    print("state:", st, f"after {i}s")
    rows = d.execute_script("""
      return [...document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or, tr.gsc_a_tr')].map(r => ({
        t: (r.querySelector('h3.gs_rt a, h3.gs_rt, a.gsc_a_at')?.textContent || '').slice(0, 60),
        b: [...r.querySelectorAll('.jq-badge')].map(b => b.textContent + ' {' + (b.title || '').split('\\n')[0] + '}')}));""")
    for r in rows:
        print(f"  {' '.join(r['b'])[:52]:52} | {r['t']}")
    d.save_screenshot("/tmp/fast-venue-rank-firefox.png")
finally:
    d.quit()
