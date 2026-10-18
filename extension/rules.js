// Turns the generated site rules (sites.generated.js) into patterns for
// the sites set on the options page, and finds which rule a page matches.
// Shared by the page script (content.js) and the background worker.
/* global self */
(function () {
  // "https://www.example.com/x" -> "example.com".
  function hostOf(url) {
    const match = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url || '');
    return match ? match[1].toLowerCase() : null;
  }

  function escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function sameSite(host, siteHost) {
    return host === siteHost || host.endsWith(`.${siteHost}`);
  }

  // sites: { mangaSiteUrl: 'https://…', … } (the options page). Returns
  // the types that have at least one site set, each with its sites' hosts
  // and its sources' patterns (sources whose site isn't set are left out).
  function build(sites) {
    const placeholders = self.MT_PLACEHOLDERS;
    return self.MT_TYPES.map((type) => {
      const keys = Object.keys(placeholders).filter((k) => k.startsWith(`${type.key}Site`));
      const hosts = keys.map((k) => hostOf(sites[k])).filter(Boolean);
      const sources = type.sources
        .map((src) => {
          let pattern = src.pattern;
          let host = null;
          let missing = false;
          Object.keys(placeholders).forEach((k) => {
            const stand = escape(hostOf(placeholders[k]));
            if (!pattern.includes(stand)) return;
            const real = hostOf(sites[k]);
            if (!real) {
              missing = true;
              return;
            }
            pattern = pattern.split(stand).join(escape(real));
            host = real;
          });
          return missing ? null : { ...src, regex: new RegExp(pattern, src.flags), host };
        })
        .filter(Boolean);
      return { key: type.key, label: type.label, hosts, sources };
    }).filter((type) => type.hosts.length > 0);
  }

  // The type and source a page belongs to: { type, source, match }, or null.
  function resolve(types, url) {
    const host = hostOf(url);
    if (!host) return null;
    for (const type of types) {
      if (!type.hosts.some((h) => sameSite(host, h))) continue;
      for (const source of type.sources) {
        if (source.host && !sameSite(host, source.host)) continue;
        const match = url.match(source.regex);
        if (match) return { type, source, match };
      }
    }
    return null;
  }

  // Every site's origin, for permissions and where the page script runs.
  function origins(sites) {
    const list = [];
    Object.keys(self.MT_PLACEHOLDERS).forEach((k) => {
      const host = hostOf(sites[k]);
      if (host) list.push(`https://${host}/*`, `https://*.${host}/*`);
    });
    return list;
  }

  self.MTRules = { hostOf, build, resolve, origins };
})();
