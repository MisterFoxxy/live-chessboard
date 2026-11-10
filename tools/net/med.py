import subprocess, sys, numpy as np
from PIL import Image
v = sys.argv[1]
dur = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',v],capture_output=True,text=True).stdout)
ts = np.linspace(min(5, dur*0.05), min(120, dur*0.5), 11)
fr = []
for t in ts:
    raw = subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',v,'-frames:v','1','-vf','crop=720:480:0:0','-f','rawvideo','-pix_fmt','rgb24','-'],capture_output=True).stdout
    if len(raw) == 720*480*3: fr.append(np.frombuffer(raw,np.uint8).reshape(480,720,3))
Image.fromarray(np.median(np.stack(fr),0).astype(np.uint8)).save(sys.argv[2])
