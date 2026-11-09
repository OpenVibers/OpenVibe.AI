'use strict';
const input = { site: 'live', from: '2026-11-02', to: '2026-11-08', sources: [{ source_type: 'git.commit', title: 'Add channel search', url: 'https://github.com/OpenVibers/OpenVibe.Live/commit/abc', content: 'The channel page now has search.' }], stories: [{ title: 'Channel search', sources: [0] }], screenshots: [{ source: 0, media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ', alt: 'The channel search field', caption: 'Search on the channel page' }], voice: 'Plain language, first person plural.' };
const para = text => ({ text, citations: [0] });
const draft = { names: ['Channel Finder', 'Search Party', 'Lost Channels', 'Channel Surfing', 'Finding Channels'], title: 'Search Party', summary: para('We added search to the channel page.'), sections: [{ heading: 'Channel search', sources: [0], paragraphs: [para('We added search to the channel page.'), para('You can search from the channel page.')] }] };
module.exports = { input, draft };
