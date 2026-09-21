"""Score the optional Electron reliability runs against their frozen references."""
import argparse
import json
from pathlib import Path
import wave
import benchmark as bm
from rapidfuzz.distance import Levenshtein
from pyannote.core import Annotation, Segment, Timeline
from pyannote.metrics.diarization import DiarizationErrorRate

parser=argparse.ArgumentParser()
parser.add_argument('--before',action='store_true',help='Score the retained pre-fix run, if present')
args=parser.parse_args()
root=bm.ROOT
w=root/'tmp/speaker-comparison/validation'
captured_dir=w/'before-word-boundaries' if args.before else w
manifest=bm.read(w/'fleurs-manifest.json')
rows=[]
for sample in manifest['rows']:
    with wave.open(str(w/f"da-{sample['index']}.wav")) as audio: duration=audio.getnframes()/audio.getframerate()
    for mode in ['auto','da','turbo-auto']:
        p=captured_dir/f"danish-{sample['index']}-{mode}.json"
        if not p.exists(): continue
        captured=bm.read(p);r=captured['result']
        ref=bm.tokens(sample['reference']);hyp=bm.tokens(' '.join(s['text'] for s in r['segments']))
        row=dict(index=sample['index'],model=r['model'],mode=mode,duration=duration,
                 errors=Levenshtein.distance(ref,hyp),referenceWords=len(ref),
                 detectedLanguage=r.get('languageDetection'),rawSpeakerCount=r['diarization']['speakerCount'],
                 finalSpeakerCount=r['speakerCount'],elapsedSeconds=captured['elapsedMs']/1000)
        rows.append(row)
totals={}
for mode in ['auto','da','turbo-auto']:
    selected=[r for r in rows if r['mode']==mode]
    if not selected: continue
    errors=sum(r['errors'] for r in selected);words=sum(r['referenceWords'] for r in selected)
    totals[mode]=dict(clips=len(selected),errors=errors,referenceWords=words,wer=errors/words,
                      danishDetected=sum(r['detectedLanguage']['detected']=='da' for r in selected),
                      oneSpeaker=sum(r['finalSpeakerCount']==1 for r in selected))
p=captured_dir/'long-meeting-auto.json';captured=bm.read(p);r=captured['result']
def annotation(turns):
    a=Annotation()
    for i,t in enumerate(turns): a[Segment(t['start'],t['end']),i]=t['speaker']
    return a
reference=annotation(bm.parse_rttm((root/'tmp/speaker-comparison/sources/ES2004a.rttm').read_text()))
hypothesis=annotation(r['diarization']['segments'])
uem=(root/'tmp/speaker-comparison/sources/ES2004a.uem').read_text().split()
metric=DiarizationErrorRate(collar=0,skip_overlap=False)
details=metric(reference,hypothesis,uem=Timeline([Segment(float(uem[2]),float(uem[3]))]),detailed=True)
long=dict(duration=r['diarization']['durationSec'],elapsedSeconds=captured['elapsedMs']/1000,
          referenceSpeakers=len(reference.labels()),rawSpeakerCount=len(hypothesis.labels()),finalSpeakerCount=r['speakerCount'],
          lastTranscriptTime=max(s['end'] for s in r['segments']),segments=len(r['segments']),
          detectedLanguage=r['languageDetection'],der={k:float(v) for k,v in details.items()},
          progressStages=sorted(set(p.get('stage','') for p in captured['progress'])))
source=bm.read(Path(__file__).with_name('reliability-sources.json'))
report=dict(danish=dict(source=source['source'],rows=rows,totals=totals),longMeeting=long,
            limits=['Six short Danish read-speech clips, not Danish meetings or language switching.',
                    'Word error uses the existing benchmark Unicode tokenizer; no speaker labels are included.',
                    'One English meeting; zero-collar DER includes overlap.',
                    'Elapsed times are observed complete IPC wall times, not controlled performance benchmarks.'])
(w/('accuracy-before.json' if args.before else 'accuracy.json')).write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(dict(danish=totals,longMeeting=long),indent=2))
