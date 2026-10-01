// Display grouping only. Does not broaden which traffic the collector includes.
const labels = ['ChatGPT', 'Gemini', 'Perplexity', 'Claude', 'Copilot', 'You.com', 'Poe', 'Grok', 'DuckAssist'];
export function trafficSourceLabel(value) {
 const source=String(value||'(not set)').trim();
 return labels.find(label=>label.toLowerCase()===source.toLowerCase())||source;
}
