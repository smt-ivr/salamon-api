// emailDesign.js
// מנוע העיצוב של מערכת הדיוור: ערכות צבעים, פריסות ובניית מייל שנראה טוב ב-Gmail, Outlook ובטלפון.
// גם התצוגה המקדימה בניהול נבנית כאן, כך שמה שרואים בתצוגה הוא בדיוק מה שנשלח.

import { escapeHtml } from './emailService.js';

const LOGO = 'https://smt-tel-manager.netlify.app/salamon-logo.png';

export const THEMES = {
    salamon: { label: 'סלומון', page: '#eef1f7', card: '#ffffff', text: '#334155', title: '#0f172a', muted: '#94a3b8', accent: '#16a34a', accent2: '#0ea5e9', soft: '#f0fdf4', softBorder: '#bbf7d0' },
    ocean: { label: 'כחול רשמי', page: '#eaf1fb', card: '#ffffff', text: '#334155', title: '#0b2545', muted: '#8aa0bd', accent: '#2563eb', accent2: '#06b6d4', soft: '#eff6ff', softBorder: '#bfdbfe' },
    royal: { label: 'סגול מלכותי', page: '#f1eefb', card: '#ffffff', text: '#3f3d56', title: '#1e1b4b', muted: '#a09cc0', accent: '#7c3aed', accent2: '#db2777', soft: '#f5f3ff', softBorder: '#ddd6fe' },
    sunset: { label: 'חגיגי', page: '#fdf2e9', card: '#ffffff', text: '#44403c', title: '#431407', muted: '#b4a49a', accent: '#ea580c', accent2: '#e11d48', soft: '#fff7ed', softBorder: '#fed7aa' },
    night: { label: 'לילה', page: '#0b1120', card: '#111827', text: '#cbd5e1', title: '#f8fafc', muted: '#64748b', accent: '#22c55e', accent2: '#38bdf8', soft: '#0f1f17', softBorder: '#166534' },
    minimal: { label: 'נקי ופשוט', page: '#ffffff', card: '#ffffff', text: '#374151', title: '#111827', muted: '#9ca3af', accent: '#111827', accent2: '#111827', soft: '#f9fafb', softBorder: '#e5e7eb' },
};

export const LAYOUTS = ['card', 'banner', 'letter'];

const HEX = /^#[0-9a-f]{6}$/i;
const safeUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');

// ניקוי והשלמת ברירות מחדל לעיצוב שהגיע מהדפדפן
export function normalizeDesign(d = {}) {
    const theme = THEMES[d.theme] ? d.theme : 'salamon';
    return {
        theme,
        layout: LAYOUTS.includes(d.layout) ? d.layout : 'card',
        accent: HEX.test(d.accent || '') ? d.accent : '',
        align: d.align === 'center' ? 'center' : 'right',
        bannerUrl: safeUrl(d.bannerUrl),
        eyebrow: String(d.eyebrow || '').slice(0, 80),
        title: String(d.title || '').slice(0, 200),
        bodyMode: d.bodyMode === 'html' ? 'html' : 'text',
        body: String(d.body || '').slice(0, 20000),
        highlight: String(d.highlight || '').slice(0, 1000),
        ctaLabel: String(d.ctaLabel || '').slice(0, 60),
        ctaUrl: safeUrl(d.ctaUrl),
        cta2Label: String(d.cta2Label || '').slice(0, 60),
        cta2Url: safeUrl(d.cta2Url),
        signature: String(d.signature || '').slice(0, 300),
        footnote: String(d.footnote || '').slice(0, 400),
    };
}

// משתנים אישיים: {{name}}, {{first_name}}, {{phone}}, {{email}}
export function personalize(text, person = {}) {
    const name = person.name || '';
    const vars = { name: name || 'לקוח יקר', first_name: (name.split(/\s+/)[0]) || 'לקוח יקר', phone: person.phone || '', email: person.email || '' };
    return String(text || '').replace(/\{\{\s*(name|first_name|phone|email)\s*\}\}/g, (_, k) => vars[k]);
}

// טקסט רגיל עם סימונים פשוטים: **מודגש**, שורה שמתחילה ב "- " היא רשימה, קישורים נלחצים
function textToHtml(text, t, link) {
    const lines = escapeHtml(text).split(/\r?\n/);
    let html = '', list = [];
    const flush = () => { if (list.length) { html += `<ul style="margin:6px 0 12px 0; padding:0 22px 0 0;">${list.map(li => `<li style="margin:3px 0;">${li}</li>`).join('')}</ul>`; list = []; } };
    const inline = s => s
        .replace(/\*\*(.+?)\*\*/g, `<b style="color:${t.title};">$1</b>`)
        .replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${link(u.replace(/&amp;/g, '&'))}" style="color:${t.accentText}; font-weight:600;">${u}</a>`);
    for (const line of lines) {
        const m = line.match(/^\s*[-•]\s+(.*)$/);
        if (m) { list.push(inline(m[1])); continue; }
        flush();
        html += line.trim() ? `<p style="margin:0 0 12px 0;">${inline(line)}</p>` : '';
    }
    flush();
    return html;
}

// HTML חופשי של המנהל: הקישורים עוברים דרך מעקב ההקלקות
function htmlWithTracking(html, link) {
    return html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (_, u) => `href="${link(u.replace(/&amp;/g, '&'))}"`);
}

function button(label, href, t, primary) {
    const bg = primary ? t.accent : 'transparent';
    const color = primary ? '#ffffff' : t.accentText;
    const border = primary ? t.accent : t.accentText;
    return `<td style="padding:4px;"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:12px; background:${bg}; border:2px solid ${border};">
        <a href="${href}" style="display:inline-block; padding:13px 30px; font-size:15.5px; font-weight:700; color:${color}; text-decoration:none; border-radius:12px;">${escapeHtml(label)}</a>
    </td></tr></table></td>`;
}

/**
 * בניית המייל המלא.
 * link(url) מחזיר את כתובת הקישור (עם מעקב הקלקות), pixelUrl הוא פיקסל מעקב הפתיחה.
 */
export function renderEmail({ design, subject, preheader, person = {}, link = u => u, pixelUrl = '', unsubscribeUrl = '' }) {
    const d = normalizeDesign(design);
    const base = THEMES[d.theme];
    const accent = d.accent || base.accent;
    const t = { ...base, accent, accent2: d.accent ? d.accent : base.accent2, accentText: d.theme === 'night' ? '#86efac' : accent };
    if (d.theme === 'minimal' && !d.accent) t.accentText = '#111827';
    const p = s => personalize(s, person);
    const align = d.align === 'center' ? 'center' : 'right';
    const safeLink = u => escapeHtml(link(u));

    const body = d.bodyMode === 'html' ? htmlWithTracking(p(d.body), safeLink) : textToHtml(p(d.body), t, safeLink);
    const highlight = d.highlight ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 14px 0;"><tr>
        <td style="background:${t.soft}; border:1px solid ${t.softBorder}; border-radius:14px; padding:14px 18px; font-size:15.5px; line-height:1.7; color:${t.title};">${textToHtml(p(d.highlight), t, safeLink)}</td></tr></table>` : '';
    const ctas = [d.ctaLabel && d.ctaUrl ? button(p(d.ctaLabel), safeLink(d.ctaUrl), t, true) : '', d.cta2Label && d.cta2Url ? button(p(d.cta2Label), safeLink(d.cta2Url), t, false) : ''].join('');
    const ctaRow = ctas ? `<tr><td align="${align === 'center' ? 'center' : 'right'}" style="padding:12px 34px 8px 34px;"><table role="presentation" cellspacing="0" cellpadding="0"><tr>${ctas}</tr></table></td></tr>` : '';
    const signature = d.signature ? `<tr><td style="padding:10px 34px 0 34px; font-size:14.5px; line-height:1.6; color:${t.text}; text-align:${align};">${escapeHtml(p(d.signature)).replace(/\n/g, '<br>')}</td></tr>` : '';
    const footnote = d.footnote ? `<tr><td style="padding:14px 34px 0 34px; font-size:12.5px; line-height:1.6; color:${t.muted}; text-align:${align};">${escapeHtml(p(d.footnote)).replace(/\n/g, '<br>')}</td></tr>` : '';
    const title = d.title ? `<div style="font-size:${d.layout === 'banner' ? 26 : 24}px; line-height:1.35; font-weight:800; color:${d.layout === 'banner' ? '#ffffff' : t.title};">${escapeHtml(p(d.title))}</div>` : '';
    const eyebrow = d.eyebrow ? `<div style="font-size:13px; font-weight:700; color:${d.layout === 'banner' ? 'rgba(255,255,255,.85)' : t.accentText}; letter-spacing:.3px; margin-bottom:8px;">${escapeHtml(p(d.eyebrow))}</div>` : '';
    const image = d.bannerUrl ? `<tr><td style="padding:0; font-size:0; line-height:0;"><img src="${escapeHtml(d.bannerUrl)}" width="560" alt="" style="display:block; width:100%; max-width:560px; height:auto; border:0;"></td></tr>` : '';

    let head;
    if (d.layout === 'banner') {
        head = `${image}<tr><td style="background:${t.accent}; background-image:linear-gradient(135deg,${t.accent},${t.accent2}); padding:34px 34px 30px 34px; text-align:${align};">
            <img src="${LOGO}" width="46" height="46" alt="" style="display:${align === 'center' ? 'inline-block' : 'block'}; border-radius:50%; border:3px solid rgba(255,255,255,.6); margin-bottom:14px;">
            ${eyebrow}${title}</td></tr>`;
    } else if (d.layout === 'letter') {
        head = `${image}<tr><td style="padding:30px 34px 0 34px; text-align:${align};">
            <table role="presentation" cellspacing="0" cellpadding="0" ${align === 'center' ? 'align="center"' : ''}><tr>
                <td style="padding-left:10px;"><img src="${LOGO}" width="34" height="34" alt="" style="display:block; border-radius:50%;"></td>
                <td style="font-size:15px; font-weight:700; color:${t.title};">עכשיו סלומון</td></tr></table>
            <div style="height:1px; background:${t.softBorder}; margin:18px 0 22px 0;"></div>${eyebrow}${title}</td></tr>`;
    } else {
        head = `<tr><td style="height:6px; background:${t.accent}; background-image:linear-gradient(90deg,${t.accent},${t.accent2}); font-size:0; line-height:0;">&nbsp;</td></tr>
            ${image}<tr><td style="padding:32px 34px 4px 34px; text-align:${align};">${eyebrow}${title}</td></tr>`;
    }
    const outerLogo = d.layout === 'card' ? `<tr><td align="center" style="padding:0 0 18px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            <td style="padding-left:10px;"><img src="${LOGO}" width="40" height="40" alt="" style="display:block; border-radius:50%; border:0;"></td>
            <td style="font-size:17px; font-weight:700; color:${t.title};">עכשיו סלומון</td></tr></table></td></tr>` : '';

    return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${d.theme === 'night' ? 'dark' : 'light'}"><title>${escapeHtml(p(subject || d.title))}</title></head>
<body style="margin:0; padding:0; background:${t.page};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(p(preheader || ''))}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${t.page};">
<tr><td align="center" style="padding:30px 12px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px; font-family:'Segoe UI',Arial,Helvetica,sans-serif; direction:rtl; text-align:right;">
        ${outerLogo}
        <tr><td style="background:${t.card}; border-radius:22px; ${d.theme === 'minimal' ? `border:1px solid ${t.softBorder};` : 'box-shadow:0 12px 32px rgba(15,23,42,.08);'} overflow:hidden;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                ${head}
                <tr><td style="padding:16px 34px 4px 34px; font-size:15.5px; line-height:1.75; color:${t.text}; text-align:${align};">${highlight}${body}</td></tr>
                ${ctaRow}${signature}${footnote}
                <tr><td style="height:28px;"></td></tr>
            </table>
        </td></tr>
        <tr><td align="center" style="padding:20px 10px 0 10px; font-size:12px; line-height:1.7; color:${t.muted};">
            © ${new Date().getFullYear()} עכשיו סלומון מבית SMT
            ${unsubscribeUrl ? `<br>לא רוצה לקבל מיילים כאלה? <a href="${escapeHtml(unsubscribeUrl)}" style="color:${t.muted};">הסרה מרשימת התפוצה</a>` : ''}
        </td></tr>
    </table>
</td></tr>
</table>
${pixelUrl ? `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block; width:1px; height:1px; border:0; opacity:0;">` : ''}
</body></html>`;
}

// גרסת טקסט (למי שהמייל שלו לא מציג HTML)
export function renderText({ design, person = {} }) {
    const d = normalizeDesign(design);
    const p = s => personalize(s, person);
    const body = d.bodyMode === 'html' ? p(d.body).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '') : p(d.body);
    return [d.title && p(d.title), d.highlight && p(d.highlight), body, d.ctaLabel && d.ctaUrl ? `${p(d.ctaLabel)}: ${d.ctaUrl}` : '', d.cta2Label && d.cta2Url ? `${p(d.cta2Label)}: ${d.cta2Url}` : '', d.signature && p(d.signature)]
        .filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// כל הקישורים שבמייל, לפי הסדר, כדי שמעקב ההקלקות יפנה רק לכתובות שנשמרו
export function collectLinks(design) {
    const links = [];
    renderEmail({ design, subject: '', link: u => { if (!links.includes(u)) links.push(u); return u; } });
    return links;
}
