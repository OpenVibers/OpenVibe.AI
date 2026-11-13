'use strict';
/**
 * The two prompts video.analyze writes with.
 *
 *   frame     one keyframe: what is shown in it and the text on screen. A vision model sees the picture
 *             and nothing else, so the prompt tells it to say only what is in the picture and to leave
 *             the text empty when there is none.
 *   analysis  the whole video: the chapters, the summary, the people, objects and places that were
 *             named, the tags, and the answer to the question that was asked. The model is given what
 *             the tools found (the measured facts, the frames with their captions, the transcript with
 *             its times) and may name nothing that is not in them.
 *
 * Both prompts ask for JSON and nothing else. The shape is checked before the answer is used
 * (server/video-analysis/schema.js): an answer that does not fit is asked once more, and a second bad
 * answer fails that step with a named gap. Nothing is ever filled in.
 */

/** One keyframe: what is shown, and what is written on screen. */
function framePrompt({ t = 0, index = 1, total = 1 } = {}) {
    const at = Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
    return {
        system: 'You describe one frame of a video for someone who cannot see it. Say only what is in the picture: what is shown, who is in it, and the text written on screen. Never guess what happened before or after this frame, never name a person you cannot read or see, and never say a name unless it is written on screen or said in the frame. If there is no readable text on screen, return an empty text. If the frame shows sex acts or pornography, say so plainly. Answer with only the JSON object.',
        user: 'This is frame ' + index + ' of ' + total + ', at ' + at + ' of the video.\n'
            + 'Answer with JSON: { "caption": one sentence (at most 300 characters) on what is shown, "text": the text written on screen, exactly as it reads, or "" when there is none, "people": the people visible, by what the picture itself shows, "objects": the notable objects, "places": the place if the picture shows it, "explicit": "fine" unless the frame shows sex acts or pornography }.\n'
            + 'Do not describe what you think the video is about. Describe this frame.',
    };
}

/** The whole video: the chapters, the summary, the named people, objects and places, the tags, the answer. */
function analysisPrompt({ probe = {}, frames = [], transcript = null, ask = null, duration = 0 } = {}) {
    const facts = [
        'Length: ' + Math.round(duration || probe.duration_s || 0) + ' s.',
        probe.video ? 'Picture: ' + probe.video.width + 'x' + probe.video.height + ' ' + probe.video.codec + ' at ' + probe.video.fps + ' fps.' : 'No video stream.',
        probe.audio ? 'Sound: ' + probe.audio.codec + ', ' + probe.audio.channels + ' channel(s).' : 'No audio stream.',
    ].join(' ');
    const frameLines = frames.map((f) => '- ' + Math.round(f.t) + 's: ' + (f.caption || '(nothing was read)') + (f.text ? ' | on screen: ' + f.text : '')).join('\n') || '(no frame was read)';
    const speech = transcript && transcript.text ? transcript.text.slice(0, 12000) : '(there is no transcript)';
    const q = ask ? 'The question to answer: ' + ask : 'No question was asked; leave the answer out.';
    return {
        system: 'You write what a video is, from what a machine measured, what was seen in its frames and what was said in it. Use only what you are given. Never name a person, place or object that is not in the frames or the transcript; never invent an event, a number, a quote or a time; never guess at a name from a face. Every entity you name carries the time it was seen (from a frame) or said (from speech); give the time you were given and no other. The chapters cover the video in order, from its first second to its last, without gaps and without overlaps. Write the summary in plain English. Answer the question only from what the video shows and says; if the video does not answer it, say so. Answer with only the JSON object.',
        user: facts
            + '\n\nWhat was seen in the frames (time, what is shown, the text on screen):\n' + frameLines
            + '\n\nWhat was said (the transcript):\n' + speech
            + '\n\n' + q
            + '\n\nAnswer with JSON: { "summary": what the video is and what happens in it, in at most 1200 characters, "chapters": [ { "start": seconds, "end": seconds, "title": a short title } ], "entities": [ { "name": as it is shown or said, "kind": "person", "object", "place" or "organization", "evidence": [ { "t": seconds, "from": "frame" or "speech" } ] } ], "tags": [ up to 20 short tags ], "answer": the answer to the question, when one was asked }.\n'
            + 'Every chapter needs a start, an end and a title. Every entity needs its evidence.',
    };
}

module.exports = { framePrompt, analysisPrompt };
