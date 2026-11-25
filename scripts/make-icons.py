# Draws the app icons. Run: python3 scripts/make-icons.py
from PIL import Image, ImageDraw
TEAL=(15,92,92); CREAM=(247,244,238); GOLD=(224,168,0)
def draw(size, maskable=False, badge=False):
    S=size*4
    im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    if badge:
        # monochrome white glyph on transparent, for the Android status bar
        m=S*0.12; d.rounded_rectangle([m,m*1.6,S-m,S-m],radius=S*0.1,outline=(255,255,255,255),width=int(S*0.09))
        d.rectangle([m,m*1.6,S-m,S*0.4],fill=(255,255,255,255))
        return im.resize((size,size),Image.LANCZOS)
    if maskable: d.rectangle([0,0,S,S],fill=TEAL); pad=S*0.2
    else: d.rounded_rectangle([0,0,S,S],radius=S*0.22,fill=TEAL); pad=S*0.16
    x0,y0,x1,y1=pad,pad*1.15,S-pad,S-pad
    r=S*0.06
    d.rounded_rectangle([x0,y0,x1,y1],radius=r,fill=CREAM)
    d.rounded_rectangle([x0,y0,x1,y0+(y1-y0)*0.27],radius=r,fill=GOLD)
    d.rectangle([x0,y0+(y1-y0)*0.15,x1,y0+(y1-y0)*0.27],fill=GOLD)
    for fx in (0.3,0.7):
        cx=x0+(x1-x0)*fx; w=S*0.035
        d.rounded_rectangle([cx-w,y0-S*0.05,cx+w,y0+S*0.07],radius=w,fill=CREAM)
    # a big tick-like dot grid: one highlighted day
    gx0=x0+(x1-x0)*0.12; gy0=y0+(y1-y0)*0.38; cw=(x1-x0)*0.76/4; ch=(y1-y0)*0.52/3
    for row in range(3):
        for col in range(4):
            cx=gx0+cw*col+cw/2; cy=gy0+ch*row+ch/2; rr=min(cw,ch)*0.22
            if row==1 and col==2:
                rr2=min(cw,ch)*0.42; d.ellipse([cx-rr2,cy-rr2,cx+rr2,cy+rr2],fill=TEAL)
            else: d.ellipse([cx-rr,cy-rr,cx+rr,cy+rr],fill=(190,182,168))
    return im.resize((size,size),Image.LANCZOS)
draw(192).save('public/icons/icon-192.png'); draw(512).save('public/icons/icon-512.png')
draw(512,maskable=True).save('public/icons/maskable-512.png'); draw(96,badge=True).save('public/icons/badge-96.png')
