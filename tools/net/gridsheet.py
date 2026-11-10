from PIL import Image, ImageDraw, ImageFont
import sys
names = sys.argv[2:]
cols = 2
rows = (len(names)+1)//2
sheet = Image.new('RGB', (720*cols, 480*rows), 'black')
for k, n in enumerate(names):
    im = Image.open(f'med/{n}.png').convert('RGB')
    d = ImageDraw.Draw(im)
    for x in range(0, 720, 40):
        d.line([(x,0),(x,480)], fill=(255,0,0) if x%200==0 else (255,160,0), width=1)
        d.text((x+2, 42), str(x), fill=(255,255,0))
    for y in range(0, 480, 40):
        d.line([(0,y),(720,y)], fill=(255,0,0) if y%200==0 else (0,200,255), width=1)
        d.text((2, y+2), str(y), fill=(0,255,255))
    d.rectangle([600,0,720,30], fill=(0,0,0)); d.text((610,8), n, fill=(255,255,255))
    sheet.paste(im, ((k%cols)*720, (k//cols)*480))
sheet.save(sys.argv[1])
