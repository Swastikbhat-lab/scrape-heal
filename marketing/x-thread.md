# X/Twitter thread

**Thread title:** the 3am cron job story

1.
my scraper broke at some point last month
i found out when a spreadsheet came back empty, a week later
no error. the site redesigned, renamed a class, my selector pointed at nothing
so i built the opposite of that

2.
it's a loop:
- every run, validate what you extracted (enough items? no empty fields? same values as last week?)
- if it's broken, look at the live page for elements that still contain the known-good data
- derive new selectors from those
- re-run, verify, and ONLY then ship the fix

3.
the part i care most about:
it won't ship a repair it can't verify
re-extract from the live page, require the same items as the last good run
a healer that doesn't verify is just a more confident way to break your data

4.
demo is the whole pitch — watch it break itself and fix itself:

healthy → site redeploys overnight → 0 items extracted → healer finds ".item" and "h2.title" → verified → identical data

5.
~300 lines, MIT, runs locally, playwright under the hood
https://github.com/Swastikbhat-lab/scrape-heal

6.
honest limits: the "known data" trick assumes the data still exists, just moved.
when the data itself changes, i'm guessing LLM-assisted repair is the answer — but
if you've solved that dumber, i'd love to hear it. and yes, watchdog mode is next.
