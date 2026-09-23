# loc-voices-remembering-slavery
Recorded interviews with people who lived through slavery in the United States, from the American Folklife Center at the Library of Congress. This edition presents twelve of them, recorded between 1935 and 1975, with the words appearing as they are spoken.

**Visualizing Voices** is an independent edition of the Library of Congress collection [*Voices Remembering Slavery: Freed People Tell Their Stories*](https://www.loc.gov/collections/voices-remembering-slavery/). It is not affiliated with or endorsed by the Library. It was designed and built by Claude Opus 5.5, an AI model made by Anthropic, working with Stiles Lowe, who directed its design and editorial choices.

## What the site is

- **Contents:** the interviews listed like the contents page of a book.
- **Interview player:** each interview plays with the transcript shown in large type, word by word as it is spoken. Interviews recorded on several disc sides play as one continuous listen.
- **Transcripts:** a plain, readable page for every interview, with each paragraph linked to its moment in the audio.
- **Notes on language:** a glossary of words and phrases the speakers use (*the break up*, *the surrender*, *old master*, and so on), each with links to where you can hear them said.
- **How this was made:** a page for listeners on what the edition keeps and what it changes.

## What is and isn't changed

- **Audio:** streamed directly from the Library of Congress (`tile.loc.gov`). It is never edited, trimmed, filtered or re-hosted.
- **Words:** the Library's published transcripts. No word is added, removed, corrected or reworded, including the language of the period.
- **Presentation only:**
  - the text is split into phrases
  - speaker labels are made consistent where a name is spelled several ways
  - the transcriber's `???` is shown as *unclear*, and words marked `(?)` appear in italics
  - file headings such as "END OF SIDE A" are left out
  - interviewees are listed by their own names; the Library's catalogue titles, some of which use "Aunt" and "Uncle", are shown in full on each interview's opening page

## How it works

The Library's transcripts don't say *when* each word is spoken, so the timing is estimated. The build runs in three stages:

```
 loc.gov ──fetch──▶ library/audio/*.mp3 ─┐
         └────────▶ library/transcripts/*.xml ─┐
                                               ▼
          whisper.cpp (GPU) ──▶ library/asr/*.json      word timings, as heard
                                               │
          align to the Library's text ◀────────┘
                     ▼
          library/aligned/*.json                        the Library's words, timed
                     ▼
          build-site ──▶ site-data/, read/, dist/       what the site reads
```

1. **Fetch** (`scripts/fetch-library.mjs`) downloads each recording's MP3 and transcript XML listed in `library/manifest.json`. The audio is only needed on the machine that does the syncing; the live site streams from the Library.
2. **Align** (`scripts/align.mjs`) has speech recognition listen to each recording, using OpenAI's Whisper models run with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). It runs the `medium.en` model, with `base.en` as a fallback in quiet, noisy stretches. Whisper's own transcription is used only for timing and is never shown. Its words are matched to the Library's transcript with a global sequence alignment (Needleman–Wunsch, tolerant of misspellings and dialect spellings), and matched words take Whisper's timestamps. Unmatched words are spaced evenly between matched neighbours. About two thirds of words match directly across this batch. Interviews under 50% are marked *sync approximate*.
3. **Build** (`scripts/build-site.mjs`) joins each interview's sides onto one continuous timeline, adds the credit lines and glossary moments, and renders the static transcript pages.

The site itself is plain HTML, CSS and JavaScript, with no framework and nothing to install to view it.

## Running it locally

Requires [Node.js](https://nodejs.org/) 22 or later.

```bash
node scripts/build-site.mjs
node scripts/serve.mjs
```

Then open http://localhost:5173. Locally the player uses audio from `library/audio/` if you have fetched it; add `?remote=1` to an interview's address to stream from the Library instead, as the live site does.

## Re-syncing or adding recordings

This part needs the audio and the speech tools, which are not in the repository because of their size.

```bash
npm install
node scripts/fetch-library.mjs
```

For the GPU path, download the Windows CUDA build of whisper.cpp (`whisper-cublas-12.4.0-bin-x64.zip`) from its [releases](https://github.com/ggml-org/whisper.cpp/releases) and unzip it into `tools/whisper/bin/`, so that `tools/whisper/bin/Release/whisper-cli.exe` exists. Put the models `ggml-medium.en.bin` and `ggml-base.en.bin` from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) into `tools/whisper/`. Without them, `align.mjs` falls back to a slower CPU path (`--cpu`).

```bash
node scripts/align.mjs
```

This aligns every recording that hasn't been done yet, and can be re-run if interrupted. Other options:

| Flag | What it does |
|---|---|
| `--only <id>` | One recording (item ID) or one interview (session ID) |
| `--reuse` | Re-align from the cached Whisper output, without re-transcribing |
| `--force` | Redo recordings that already have output |
| `--cpu` | Transcribe on the CPU instead of the GPU |

`library/aligned/_report.json` lists each recording's match rate and weakest stretches. To add recordings, add their sessions to `library/manifest.json`, then fetch, align and build. The remaining recordings in the collection, mostly from the early 1930s and harder to hear, are for later batches.

## Repository layout

| Path | Contents |
|---|---|
| `index.html`, `interview.html`, `glossary.html`, `about.html` | The pages |
| `contents.js`, `player.js`, `glossary.js`, `styles.css` | Page scripts and styles |
| `library/manifest.json` | The interviews in this edition, their sides and Library links |
| `library/transcripts/` | The Library's transcript XML, as downloaded |
| `library/aligned/` | Timed transcripts, plus `_report.json` |
| `library/glossary/glossary.json` | The notes on language (hand-written) |
| `library/source/` | The Library's collection listing and a survey of all 60 recordings |
| `site-data/`, `read/` | Built data and transcript pages (generated) |
| `scripts/` | Fetch, align, build and local server |
| `netlify.toml` | Deploy settings: Netlify runs the build and publishes `dist/` |

Not in the repository, and re-created by the scripts: `library/audio/`, `library/asr/`, `tools/`, `node_modules/`, `dist/`.

## Deploying

The site is hosted on Netlify. Every push to `main` builds and publishes it. The build needs no packages; `netlify.toml` skips the speech tools, which are only needed for syncing.

## Rights and credit

The Library of Congress states that it is unaware of any copyright or other restrictions on the *Voices Remembering Slavery* collection, and that the materials are free to use and reuse. It asks that the materials be approached with respect for the people whose lives they document. Each interview credits its source collection as the Library requests, for example:

> John Henry Faulk Recordings of Negro Religious Services (AFC 1941/016), American Folklife Center, Library of Congress

The recordings contain period language, including slurs, reproduced as recorded. The notes on language explain why.
