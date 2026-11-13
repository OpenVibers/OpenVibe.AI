'use strict';
/**
 * Video workflows.
 *
 *   video.analyze  the AI reads a video (plan Z.9 step 4): ffprobe's facts, the keyframes the vision route
 *                  reads, the transcript the speech route hears, and one model that writes the chapters,
 *                  the summary, the people, objects and places that were named, the tags and the answer to
 *                  the question that was asked. The whole run is one step: server/video-analysis/ writes its
 *                  own seven-step progress, so the page sees Probe, Keyframes, Transcript, Describe, Analyse,
 *                  Explicit and Report as they happen.
 *
 * The video is a Media object, a Media attachment or a Media URL: OpenVibe.Media decides who may read it.
 * No cache: a video analysis is about one file, its frames are private to its owner, and the same video
 * read twice may be read differently. The price is computed here from the depth and the length of the
 * video, never from the body; the real cost is on the run's receipt.
 */
const { INPUT_SCHEMA, REPORT } = require('../video-analysis/schema');

const workflows = [
    {
        key: 'video.analyze', name: 'Read a video: frames, speech, chapters, summary', namespace: 'video',
        description: 'Measure a video with ffprobe, take its keyframes (the scene cuts and one every 30 s), hear it with the speech route, read every frame with the vision route, and write an ai.video-analysis@1 document: the chapters, the summary, the named people, objects and places with their times, the tags and the answer to the question that was asked.',
        input_schema: INPUT_SCHEMA,
        output_schema: REPORT,
        steps: [{ kind: 'video_analyze' }],
        default_route: null,
        cache_mode: 'none', cache_ttl_sec: 0,
        metadata: { seed: true, owner: 'exchange', retain_input: true },
    },
];

module.exports = { templates: [], workflows };
