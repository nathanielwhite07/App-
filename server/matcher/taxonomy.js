'use strict';
// Canonical interest tags -> group + synonyms that may appear in a resume or contact profile.
// Matching is done on canonical tags, so "hoops" on a resume matches "basketball" on a contact.

const TAGS = {
  // Sports & fitness
  basketball: ['sports', ['basketball', 'hoops', 'nba', 'intramural basketball']],
  soccer: ['sports', ['soccer', 'football club', 'futbol', 'premier league']],
  football: ['sports', ['american football', 'nfl', 'varsity football']],
  tennis: ['sports', ['tennis', 'pickleball', 'squash']],
  golf: ['sports', ['golf']],
  running: ['fitness', ['running', 'track and field', 'cross country', 'cross-country', '5k', '10k']],
  marathons: ['fitness', ['marathon', 'marathons', 'half marathon', 'triathlon', 'ironman']],
  hiking: ['outdoors', ['hiking', 'backpacking', 'camping', 'trail']],
  'rock climbing': ['outdoors', ['rock climbing', 'bouldering', 'climbing']],
  yoga: ['fitness', ['yoga', 'pilates', 'meditation']],
  // Games
  chess: ['games', ['chess']],
  poker: ['games', ['poker', 'game theory']],
  esports: ['games', ['esports', 'e-sports', 'video games', 'gaming']],
  // Arts & culture
  piano: ['music', ['piano', 'keyboard']],
  guitar: ['music', ['guitar', 'bass guitar']],
  jazz: ['music', ['jazz', 'saxophone', 'trumpet']],
  'hip hop': ['music', ['hip hop', 'hip-hop', 'rap']],
  photography: ['arts', ['photography', 'photographer']],
  film: ['arts', ['film', 'filmmaking', 'cinema', 'movies']],
  fashion: ['arts', ['fashion', 'design']],
  cooking: ['lifestyle', ['cooking', 'culinary', 'baking', 'chef']],
  travel: ['lifestyle', ['travel', 'study abroad', 'traveling', 'travelling']],
  reading: ['lifestyle', ['reading', 'book club', 'literature']],
  podcasts: ['lifestyle', ['podcast', 'podcasts']],
  // Professional / sector interests
  'venture capital': ['finance', ['venture capital', 'vc ', 'seed investing']],
  'private equity': ['finance', ['private equity', 'buyout', 'lbo']],
  'value investing': ['finance', ['value investing', 'investment club', 'stock pitch', 'equity research', 'portfolio management']],
  fintech: ['finance', ['fintech', 'payments', 'financial technology']],
  crypto: ['finance', ['crypto', 'cryptocurrency', 'blockchain', 'web3', 'bitcoin', 'defi']],
  'real estate': ['finance', ['real estate', 'reit', 'property']],
  startups: ['entrepreneurship', ['startup', 'startups', 'founder', 'co-founder', 'cofounder']],
  entrepreneurship: ['entrepreneurship', ['entrepreneurship', 'entrepreneur', 'pitch competition', 'hackathon']],
  'machine learning': ['tech', ['machine learning', 'deep learning', 'pytorch', 'tensorflow', 'scikit-learn', 'neural network']],
  'artificial intelligence': ['tech', ['artificial intelligence', ' ai ', 'llm', 'nlp', 'computer vision', 'generative ai']],
  sustainability: ['impact', ['sustainability', 'climate', 'esg', 'environmental']],
  'renewable energy': ['impact', ['renewable energy', 'solar', 'clean energy', 'wind energy']],
  healthcare: ['impact', ['healthcare', 'health care', 'biotech', 'pre-med', 'public health']],
  volunteering: ['impact', ['volunteer', 'volunteering', 'community service', 'nonprofit', 'non-profit', 'habitat for humanity']],
  mentorship: ['impact', ['mentor', 'mentorship', 'mentoring', 'tutor', 'tutoring']],
  'public speaking': ['communication', ['public speaking', 'toastmasters', 'model un', 'model united nations']],
  debate: ['communication', ['debate', 'mock trial', 'forensics']],
};

// Career-track keywords on a resume -> industries in the companies table.
const CAREER_TRACKS = {
  'Investment Banking': ['investment banking', 'm&a', 'mergers', 'capital markets', 'financial modeling', 'dcf', 'ib '],
  'Management Consulting': ['consulting', 'case competition', 'strategy', 'consultant'],
  'Asset Management': ['asset management', 'portfolio', 'equity research', 'hedge fund', 'investment club', 'quant'],
  Technology: ['software', 'engineering', 'python', 'javascript', 'java', 'react', 'data science', 'machine learning', 'product management'],
  Law: ['law', 'legal', 'pre-law', 'lsat', 'paralegal', 'mock trial'],
  'Accounting & Advisory': ['accounting', 'audit', 'cpa', 'tax', 'big four', 'forensic accounting'],
};

const SKILLS = ['python', 'excel', 'sql', 'r', 'java', 'javascript', 'typescript', 'c++', 'tableau', 'power bi', 'financial modeling',
  'valuation', 'dcf', 'lbo', 'bloomberg', 'capital iq', 'powerpoint', 'react', 'node', 'aws', 'machine learning', 'statistics',
  'accounting', 'gaap', 'figma', 'salesforce', 'spanish', 'mandarin', 'french', 'portuguese', 'arabic', 'hindi'];

module.exports = { TAGS, CAREER_TRACKS, SKILLS };
