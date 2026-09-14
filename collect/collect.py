#!/usr/bin/env python3
"""
collect.py — gather news coverage of solar siting fights.

Runs on GitHub Actions, on a schedule and on demand. Writes what it
finds into data/articles.json, which the page reads.

Two sources, neither of which needs an API key:

  GDELT DOC 2.0    api.gdeltproject.org. Indexes news worldwide, updates
                   every fifteen minutes, caps any one search at 250
                   articles and asks for one request every five seconds.
                   Its rolling window is roughly three months, which is
                   why this runs weekly: the archive is built up over
                   time rather than reached back for.

  Google News RSS  news.google.com/rss/search. Reaches local outlets
                   GDELT often misses, about a month back.

Only the headline, outlet, date and link are stored. Article text is
not copied.

Standard library only, so the workflow has nothing to install.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ARTICLES = os.path.join(ROOT, 'data', 'articles.json')
RUNS = os.path.join(ROOT, 'data', 'runs.json')
CODEBOOK = os.path.join(ROOT, 'codebook.json')

UA = ('Mozilla/5.0 (compatible; solar-siting-research/1.0; '
      'University of Oklahoma; +https://hbedle-subsurface.github.io/elsa_doc/)')


# --------------------------------------------------------------- helpers

def load_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


# ------------------------------------------------------------ query build

def build_queries(cfg):
    """One search per subject phrase, repeated per state where asked.

    Each topic also gets one search with no angle words attached. The angle
    clause is what finds a contested project, but it also means a story
    about a solar farm that happens not to use any of those six words is
    never seen. The wide search picks those up and the relevance score
    sorts them out afterward."""
    out = []
    for topic in cfg['topics']:
        angles = topic.get('angles', [])[:6]
        angle_clause = '(' + ' OR '.join(angles) + ')' if angles else ''
        states = cfg['states'] if topic.get('per_state') else [None]
        for state in states:
            for subject in topic['subjects']:
                terms = [subject]
                if state:
                    terms.append('"%s"' % state)
                if angle_clause:
                    terms.append(angle_clause)
                out.append({'topic': topic['id'], 'state': state,
                            'query': ' '.join(terms)})
            if angle_clause and topic.get('wide', True):
                wide = [topic['subjects'][0]]
                if state:
                    wide.append('"%s"' % state)
                out.append({'topic': topic['id'], 'state': state,
                            'query': ' '.join(wide)})
    return out


# ------------------------------------------------------------------ GDELT

GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc'


def gdelt_search(query, days, maxrecords):
    params = {
        'query': query + ' sourcecountry:US sourcelang:english',
        'mode': 'ArtList',
        'format': 'json',
        'maxrecords': str(maxrecords),
        'sort': 'DateDesc',
        'timespan': '%dd' % days,
    }
    url = GDELT_URL + '?' + urllib.parse.urlencode(params)
    raw = fetch(url)

    # GDELT answers a malformed or over-common query with a plain text
    # complaint and an HTTP 200, so a JSON failure is not a crash.
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
    except ValueError:
        msg = raw.decode('utf-8', 'replace').strip()[:160]
        return [], ('rejected: ' + msg if msg else 'rejected: empty response')

    items = []
    for a in data.get('articles', []):
        items.append({
            'title': (a.get('title') or '').strip(),
            'url': a.get('url') or '',
            'domain': (a.get('domain') or '').lower(),
            'outlet': (a.get('domain') or '').lower(),
            'published': gdelt_date(a.get('seendate', '')),
            'source': 'gdelt',
        })
    return items, None


def gdelt_date(s):
    """GDELT stamps articles as 20260913T140000Z."""
    m = re.match(r'^(\d{4})(\d{2})(\d{2})', s or '')
    return '%s-%s-%s' % m.groups() if m else ''


# ------------------------------------------------------------ Google News

GNEWS_URL = 'https://news.google.com/rss/search'


def gnews_search(query, days):
    params = {
        'q': '%s when:%dd' % (query, days),
        'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en',
    }
    url = GNEWS_URL + '?' + urllib.parse.urlencode(params)
    try:
        root = ET.fromstring(fetch(url))
    except ET.ParseError as exc:
        return [], 'unreadable feed: %s' % exc

    items = []
    for item in root.iter('item'):
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        src = item.find('source')
        outlet = (src.text or '').strip() if src is not None else ''
        src_url = src.get('url', '') if src is not None else ''
        # Google appends the outlet to the headline; the source tag has it
        if outlet and title.endswith(' - ' + outlet):
            title = title[:-(len(outlet) + 3)].strip()
        items.append({
            'title': title,
            'url': link,
            'domain': urllib.parse.urlparse(src_url).netloc.lower().replace('www.', ''),
            'outlet': outlet,
            'published': rss_date(item.findtext('pubDate') or ''),
            'source': 'googlenews',
        })
    return items, None


def rss_date(s):
    for fmt in ('%a, %d %b %Y %H:%M:%S %Z', '%a, %d %b %Y %H:%M:%S %z'):
        try:
            return datetime.strptime(s.strip(), fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return ''


# ------------------------------------------------- scoring and identity

def norm_url(u):
    """Same article shared with different tracking tags is one article."""
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return u.lower()
    host = p.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]
    keep = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
            if not k.lower().startswith(('utm_', 'fbclid', 'gclid', 'mc_'))]
    path = p.path.rstrip('/')
    return urllib.parse.urlunsplit(('https', host, path,
                                    urllib.parse.urlencode(sorted(keep)), ''))


def article_id(u):
    return hashlib.sha1(norm_url(u).encode('utf-8')).hexdigest()[:12]


def title_key(t):
    return re.sub(r'[^a-z0-9]', '', (t or '').lower())[:70]


def phrases(terms):
    """Turn the quoted query terms back into plain phrases to look for."""
    return [t.strip('"()').lower() for t in terms if t.strip('"()')]


# A county name is the capitalized word before "County". Two words only when
# the first is a real county-name prefix. Taking any two capitalized words
# produced "These Jackson County" and "Later Madison County"; no stopword
# list covers every word a sentence can start with, but the set of prefixes
# real counties use is small and closed.
COUNTY_PREFIX = {
    'st', 'ste', 'mt', 'san', 'santa', 'los', 'las', 'el', 'la', 'le', 'du',
    'de', 'del', 'van', 'new', 'red', 'big', 'black', 'white', 'green',
    'grand', 'fort', 'port', 'lake', 'deer', 'box', 'cedar', 'clear', 'cross',
    'palm', 'prince', 'king', 'queen', 'long', 'hot', 'iron', 'rio', 'sierra',
    'twin', 'west', 'east', 'north', 'south', 'little', 'silver', 'golden',
    'roger', 'dona', 'val', 'palo', 'tom', 'jeff', 'deaf', 'live', 'ben',
}
COUNTY_RE = re.compile(
    r"\b((?:[A-Z][A-Za-z'\-]*\.?\s+)?[A-Z][A-Za-z'\-]+)\s+(County|Parish|Borough)\b")


def find_counties(text):
    out = []
    for m in COUNTY_RE.finditer(text or ''):
        parts = m.group(1).split()
        if len(parts) == 2 and parts[0].rstrip('.').lower() not in COUNTY_PREFIX:
            parts = parts[1:]          # the first word belongs to the sentence
        full = ' '.join(parts) + ' ' + m.group(2)
        if full not in out:
            out.append(full)
    return out


US_STATES = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
    'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
    'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
    'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
    'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
    'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
    'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
    'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia',
    'Washington', 'West Virginia', 'Wisconsin', 'Wyoming']


def states_named(text, states):
    """States mentioned, not counting the ones that are really county names.

    Oklahoma has a Delaware County, a Texas County, an Oklahoma County and a
    Washington County, so a bare substring match reads four of its own
    counties as other states. Headlines abbreviate, so "Washington Co."
    counts as a county too.

    Longest name first, and overlapping matches are skipped, or West
    Virginia would also register as Virginia."""
    out, taken = [], []
    for st in sorted(states, key=len, reverse=True):
        for m in re.finditer(r'\b' + re.escape(st.lower()) + r'\b', text):
            if any(m.start() < end and start < m.end() for start, end in taken):
                continue
            tail = text[m.end():m.end() + 9]
            if re.match(r'\s+(county|counties|parish|borough|co\.|co\b)', tail):
                continue
            taken.append((m.start(), m.end()))
            out.append(st)
            break
    return [s for s in states if s in out]

def best_topic(text, cfg, asked):
    """Which topic the headline is actually about.

    A search for floating solar also returns ordinary solar farms, so
    judging an article against the vocabulary of whichever search found
    it throws away good results. Prefer the topic that asked, then any
    other whose words appear."""
    matches = [t for t in cfg['topics']
               if any(p in text for p in phrases(t.get('recognize') or t['subjects']))]
    if not matches:
        return None
    for t in matches:
        if t['id'] == asked:
            return t
    return matches[0]


def score_article(item, topic, state, cfg, codebook):
    """How likely this is actually about a local solar siting fight.

    A state named in the headline is a fact about the article. The state
    whose search returned it is only where it came from, so the two are
    recorded separately and the guess never gets exported as the fact."""
    title = item['title'] or ''
    text = title.lower()
    spec = best_topic(text, cfg, topic)

    score = 2 if spec else 0
    if spec is None:
        spec = next(t for t in cfg['topics'] if t['id'] == topic)
    hits = sum(1 for a in phrases(spec.get('angles', [])) if a in text)
    score += min(hits, 2)

    states = states_named(text, cfg['states'])
    counties = find_counties(title)
    if counties:
        score += 1
    if states:
        score += 1

    # Coverage from other states is kept and flagged rather than dropped.
    # Oklahoma is competing with West Virginia and Tennessee for the DOE
    # nuclear campus, so their coverage is context, not noise — but it
    # should not sit unmarked among Oklahoma's own.
    home = cfg.get('home_state')
    away = [x for x in states_named(text, US_STATES) if x != home]
    elsewhere = bool(home and away and home not in states)

    cues = [c['id'] for c in codebook['categories']
            if any(q in text for q in c['cues'])]

    return {
        'score': score,
        'topic': spec['id'],
        'states': states,
        'counties': counties,
        'elsewhere': elsewhere,
        'other_states': away,
        'via_state': state or '',
        'cues': cues,
    }


# ------------------------------------------------------------------ merge

def merge(existing, found, today):
    """Keep what is already there. New articles are added; an article
    seen again keeps its first sighting and gains any new topic."""
    by_id = {a['id']: a for a in existing}
    by_title = {title_key(a['title']): a['id'] for a in existing if a['title']}
    added = 0

    for a in found:
        aid = a['id']
        twin = by_title.get(title_key(a['title']))
        if aid in by_id:
            keep = by_id[aid]
        elif twin and twin in by_id:
            keep = by_id[twin]
        else:
            a['first_seen'] = today
            by_id[aid] = a
            if a['title']:
                by_title[title_key(a['title'])] = aid
            added += 1
            continue

        keep['last_seen'] = today
        for field in ('topics', 'states', 'counties', 'other_states', 'via_states',
                      'cues', 'sources'):
            merged = set(keep.get(field, [])) | set(a.get(field, []))
            keep[field] = sorted(merged)
        keep['score'] = max(keep.get('score', 0), a.get('score', 0))
        if not keep.get('outlet') and a.get('outlet'):
            keep['outlet'] = a['outlet']

    return list(by_id.values()), added


# ------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--states', default='',
                    help='comma separated; overrides the config for this run')
    ap.add_argument('--days', type=int, default=0,
                    help='how far back to reach; defaults to the config')
    ap.add_argument('--topics', default='',
                    help='comma separated topic ids; default is all of them')
    ap.add_argument('--dry-run', action='store_true',
                    help='print the searches and stop')
    args = ap.parse_args()

    cfg = load_json(os.path.join(HERE, 'queries.json'))
    codebook = load_json(CODEBOOK)
    if not cfg or not codebook:
        sys.exit('queries.json or codebook.json is missing')

    if args.states.strip():
        cfg['states'] = [s.strip() for s in args.states.split(',') if s.strip()]
    if args.topics.strip():
        wanted = {t.strip() for t in args.topics.split(',')}
        cfg['topics'] = [t for t in cfg['topics'] if t['id'] in wanted]
    days = args.days or cfg.get('max_age_days', 30)

    searches = build_queries(cfg)
    print('%d searches across %d states, reaching back %d days'
          % (len(searches), len(cfg['states']), days))

    if args.dry_run:
        for s in searches:
            print('  [%s/%s] %s' % (s['topic'], s['state'] or 'all', s['query']))
        return

    pause = cfg.get('gdelt_pause_seconds', 6)
    maxrec = cfg.get('gdelt_max_records', 250)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    found, problems = [], []

    for i, s in enumerate(searches, 1):
        for name, call in (('gdelt', lambda: gdelt_search(s['query'], days, maxrec)),
                           ('googlenews', lambda: gnews_search(s['query'], days))):
            try:
                items, err = call()
            except Exception as exc:                       # network, timeout
                items, err = [], '%s: %s' % (type(exc).__name__, exc)
            if err:
                problems.append('%s %s/%s — %s'
                                % (name, s['topic'], s['state'] or 'all', err))
                continue

            for item in items:
                if not item['url'] or not item['title']:
                    continue
                marks = score_article(item, s['topic'], s['state'], cfg, codebook)
                found.append({
                    'id': article_id(item['url']),
                    'title': item['title'],
                    'url': item['url'],
                    'domain': item['domain'],
                    'outlet': item['outlet'] or item['domain'],
                    'published': item['published'] or today,
                    'sources': [item['source']],
                    'topics': [marks['topic']],
                    'states': marks['states'],
                    'elsewhere': marks['elsewhere'],
                    'other_states': marks['other_states'],
                    'counties': marks['counties'],
                    'via_states': [marks['via_state']] if marks['via_state'] else [],
                    'cues': marks['cues'],
                    'score': marks['score'],
                    'last_seen': today,
                })
            print('  %2d/%d %-11s %-12s %-10s %3d results'
                  % (i, len(searches), name, s['topic'],
                     (s['state'] or 'all')[:10], len(items)))
        time.sleep(pause)

    store = load_json(ARTICLES, {'articles': []})
    before = len(store['articles'])
    articles, added = merge(store['articles'], found, today)

    threshold = cfg.get('keep_threshold', 2)
    for a in articles:
        a['weak'] = a.get('score', 0) < threshold

    articles.sort(key=lambda a: (a.get('published', ''), a.get('title', '')),
                  reverse=True)
    cap = cfg.get('keep_total', 8000)
    dropped = max(0, len(articles) - cap)
    articles = articles[:cap]

    os.makedirs(os.path.dirname(ARTICLES), exist_ok=True)
    with open(ARTICLES, 'w', encoding='utf-8') as fh:
        json.dump({'updated': now_iso(),
                   'threshold': threshold,
                   'articles': articles}, fh, ensure_ascii=False, indent=1)

    runs = load_json(RUNS, {'runs': []})
    runs['runs'].insert(0, {
        'when': now_iso(),
        'searches': len(searches),
        'states': cfg['states'],
        'days': days,
        'results': len(found),
        'new': added,
        'total': len(articles),
        'problems': problems[:25],
    })
    runs['runs'] = runs['runs'][:60]
    with open(RUNS, 'w', encoding='utf-8') as fh:
        json.dump(runs, fh, ensure_ascii=False, indent=1)

    strong = sum(1 for a in articles if not a['weak'])
    print('\n%d results, %d new, %d in the file (%d worth reading, %d weak)'
          % (len(found), added, len(articles), strong, len(articles) - strong))
    if dropped:
        print('%d oldest dropped to stay under the cap' % dropped)
    if problems:
        print('\n%d searches had trouble:' % len(problems))
        for p in problems[:10]:
            print('  ' + p)
    print('was %d articles, now %d' % (before, len(articles)))


if __name__ == '__main__':
    main()
