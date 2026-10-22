"""Soft focus on the ADJ lever (function 0x13): the native ADJ controller, ADJ mode setting menu
and image-processing functions, with every patch of the manifest installed.

List widgets, text setting and singletons are substitutes; the camera's UI, the ISP and the
real pictures are not executed. Each check compares with the unpatched image where it can.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from rear_dial_probe import RearDialProbe, SELECTOR, DATA

if not __debug__:raise RuntimeError('Validation requires Python assertions')

FN=0x13;PTR=0x55063f34;BYTE=DATA+0x9a1
VIEW,LIST,ITEM,CP,OUT,PROC,PARAM=0x62060000,0x62061000,0x62062000,0x62063000,0x62064000,0x62065000,0x62066000
NAMES=['Měkká kresba','Blødt fokus','Soft Focus','Pehmeä tarkennus','Flou artistique','Weichzeichner','Μαλακή εστίαση',
       'Lágy fókusz','Effetto flou','ソフトフォーカス','소프트 포커스','Soft focus','Miękka ostrość','Foco suave',
       'Мягкий фокус','柔焦','Enfoque suave','Mjukt fokus','ซอฟต์โฟกัส','柔焦','Yumuşak odak']
ROWS=[9,2,4,5,16,13,8,11,1,17,3,12,0,7,20,6,14,10,19,15,18]
MENU=((0x531b5588,0x531b71b4,0x531b8954),(0x531b55e4,0x531b71e4,0x531b8988),(0x531b5640,0x531b7214,0x531b89bc),
      (0x531b569c,0x531b7244,0x531b89f0),(0x531b56f8,0x531b7274,0x531b8a24))

def u32(c,a):return struct.unpack('<I',c.mem_read(a,4))[0]
def put(c,a,v):c.mem_write(a,struct.pack('<I',v))

class UI:
    def init_ui(s):
        s.ui=[];s.cursor=0
        try:s.uc.mem_map(0x55060000,0x10000)
        except Exception:pass
    def ui_hook(s,cpu,at):
        R=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R%d'%n))
        def ret(v):cpu.reg_write(reg.UC_ARM_REG_R0,v);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        if at in (0x5320b67c,0x5320b7fc):ret(0x62049000)
        elif at==0x53394758:s.ui.append(('item',R(1)));ret(ITEM)
        elif at==0x533a1808:s.ui.append(('text',R(1)));ret(0)
        elif at==0x53394820:ret(s.cursor)
        elif at==0x5339e8b0:s.ui.append(('menuitem',R(1),R(2)));ret(0)
        elif at in (0x531a3a04,0x531a3938):ret(0)
        elif at in (0x53395430,0x533947f0,0x53396f80,0x533a19b4,0x53395224,0x533ad3c0,0x533a1734):s.ui.append((hex(at),R(1)));ret(0)
        else:return False
        return True
    def state(s,fn=FN,slot=0,movie=0,byte=0,ptr=True):
        s.reset();s.ui=[]
        for k in range(1,9):put(s.uc,SELECTOR+4*k,DATA)
        for off in (0x918,0x91a,0x91c,0x91e,0x920):s.uc.mem_write(DATA+off,b'\x04')
        s.uc.mem_write(DATA+0x918+2*slot,bytes([fn]));s.uc.mem_write(BYTE,bytes([byte]))
        s.uc.mem_write(VIEW,bytes(0x300));s.uc.mem_write(VIEW+0x1f4,bytes([slot]));s.uc.mem_write(VIEW+0x270,bytes([movie]))
        put(s.uc,VIEW+0x1f0,LIST);put(s.uc,PTR,DATA if ptr else 0)

class Patched(UI,AdjProbe):
    def __init__(s,data,manifest):AdjProbe.__init__(s,data,manifest);s.init_ui()
    def _hook(s,cpu,at,size,user):
        if not s.ui_hook(cpu,at):AdjProbe._hook(s,cpu,at,size,user)
class Native(UI,RearDialProbe):
    def __init__(s,data):RearDialProbe.__init__(s,data);s.init_ui()
    def _hook(s,cpu,at,size,user):
        if not s.ui_hook(cpu,at):RearDialProbe._hook(s,cpu,at,size,user)

def max_count(p):
    p.state();c=p.uc;p.diagnostics=[]
    c.reg_write(reg.UC_ARM_REG_R0,VIEW);c.reg_write(reg.UC_ARM_REG_SP,0x610ff000);c.reg_write(reg.UC_ARM_REG_LR,0x620ff000)
    c.emu_start(0x531a1e34,0x531a1eb8,count=20000);assert not p.diagnostics
    return c.mem_read(VIEW+0x271,1)[0]

def verify(data,manifest):
    e=manifest['entries'];text,icon=e['softFocusText'],e['softFocusIcon']
    p=Patched(data,manifest);n=Native(data);c=p.uc;calls=0;rep={}
    # Names and icons: only function 0x13 changes.
    for f in range(0x16):
        got=(p.call(0x53292810,0x62049000,f),p.call(0x53293a30,0x62049000,f));calls+=2
        want=(text,icon) if f==FN else (n.call(0x53292810,0x62049000,f),n.call(0x53293a30,0x62049000,f))
        assert got==want,(f,got,want)
    roots=manifest['catalogs']['textRoots']
    for row,lang in enumerate(ROWS):
        rec=u32(c,u32(c,roots+row*4)+text*4);units,lines,_,at=struct.unpack('<BBHI',c.mem_read(rec,8))
        assert (units,lines)==(len(NAMES[lang])+1,1) and bytes(c.mem_read(at,units*2)).decode('utf-16le')==NAMES[lang]+'\0'
    desc=u32(c,manifest['catalogs']['iconRoot']+icon*4);w,h,off=struct.unpack('<HHI',c.mem_read(desc,8))
    assert (w,h)==(40,40) and off*4>=manifest['iconAddition']['originalLength']
    for at,expected in ((0x53209fb8,40),(0x53209fec,40)):assert p.call(at,0x62049000,icon)==expected;calls+=1
    # Count: 4 in still mode on every slot; the movie layout is the firmware's own.
    for slot in range(5):
        p.state(slot=slot);assert p.call(0x531a31ac,VIEW)==4
        # Movie mode uses the fixed layout 0xC, 1, 6, 0xF, 0xE: the same counts as the firmware,
        # except Image Control (slot 1), which lists the added films in a film build.
        p.state(slot=slot,movie=1);n.state(slot=slot,movie=1);calls+=3
        if slot or not manifest.get('addedLooks'):assert p.call(0x531a31ac,VIEW)==n.call(0x531a31ac,VIEW),slot
    assert max_count(p)==max_count(n)==32;calls+=2
    # Exactly one current value for every stored byte, a damaged byte reads (and is reset) as off.
    for b in list(range(4))+[4,0x13,0xaa,0xff]:
        p.state(byte=b);hits=[i for i in range(32) if p.call(0x531a3d94,VIEW,i)];calls+=32
        assert hits==[b if b<4 else 0] and c.mem_read(BYTE,1)[0]==(b if b<4 else 0),(b,hits)
    p.state(ptr=False);assert [i for i in range(32) if p.call(0x531a3d94,VIEW,i)]==[0];calls+=32
    # The native draw loop asks for every index up to the largest count: Off, Low, Medium, High, then none.
    p.state(byte=2);c.mem_write(VIEW+0x271,bytes([32]));p.call(0x531a405c,VIEW);calls+=1
    assert [x[1] for x in p.ui if x[0]=='text']==[2,9,10,11]+[0]*28
    for k in range(6):
        p.state(byte=1);p.cursor=k;p.call(0x531a3100,VIEW);calls+=1
        assert c.mem_read(BYTE,1)[0]==(k if k<4 else 1)
    p.state(ptr=False);p.cursor=2;p.call(0x531a3100,VIEW);calls+=1
    # The ADJ mode setting menu lists 0x13 at index 12 on each of the five slots.
    for slot,(draw,setter,current) in enumerate(MENU):
        p.state(fn=4);p.call(draw,0,ITEM,12);assert p.ui[-1]==('menuitem',icon,text),p.ui[-1]
        p.state(fn=4);p.call(setter,0,12);assert c.mem_read(DATA+0x918+2*slot,1)[0]==FN
        p.state(fn=FN,slot=slot);assert [i for i in range(19) if p.call(current,0,i)]==[12];calls+=21
    # Pictures: the per-picture decision and the clarity parameter.
    def slots(probe,on,where=2):
        for i,f in enumerate((0x918,0x91a,0x91c,0x91e,0x920)):probe.uc.mem_write(DATA+f,bytes([FN if on and i==where else 4]))
    def decide(probe,look,byte,on=True):
        u=probe.uc;u.mem_write(CP,bytes(0x800));u.mem_write(CP+0x77c,bytes([look]));u.mem_write(CP+0x793,b'\x04\x04\x00\x00')
        u.mem_write(OUT,bytes(0x40));u.mem_write(BYTE,bytes([byte]));put(u,PTR,DATA);slots(probe,on);probe.call(0x535131c0,OUT,CP)
        return u.mem_read(OUT+0x24,1)[0]
    for look in list(range(11,23))+[f['id'] for f in manifest.get('addedLooks',[])]:
        native_look=next((f['nativeBase'] for f in manifest.get('addedLooks',[]) if f['id']==look),look)
        off=decide(n,native_look,0);calls+=2
        assert decide(p,look,0)==off,look
        for b in (1,2,3):
            on=decide(p,look,b);calls+=1
            assert on==(off if native_look==20 else 1),(look,b,on)
            # Taken off the ADJ lever, soft focus is off whatever the byte says.
            assert decide(p,look,b,on=False)==off;calls+=1
        assert decide(p,look,9)==off
    def effect(probe,clarity,byte,on=True):
        slots(probe,on,4);u=probe.uc;u.mem_write(CP,bytes(0x800));u.mem_write(CP+0x793,bytes([4,clarity,0,0]));u.mem_write(CP+0x7b8,struct.pack('<f',1.0))
        u.mem_write(PARAM,b'\xa5'*16);u.mem_write(PROC,bytes(0x40));put(u,PROC+0x10,PARAM);u.mem_write(BYTE,bytes([byte]))
        probe.call(0x5350304c,PROC,CP,1);return struct.unpack('<h',u.mem_read(PARAM+2,2))[0],bytes(u.mem_read(PARAM,16))
    for clarity in range(9):
        native=effect(n,clarity,0)
        for b in (0,4,9,0xff):assert effect(p,clarity,b)==native
        for b in (1,2,3):
            v,raw=effect(p,clarity,b);assert v==4+b and raw[:2]+raw[4:]==native[1][:2]+native[1][4:]
            assert effect(p,clarity,b,on=False)==native
        calls+=8
    # The clarity function's row: rows 0..8 as before, 9..11 from the three soft-focus rows.
    rows=e['softFocusRows']
    for r8 in range(12):
        c.reg_write(reg.UC_ARM_REG_R3,22);c.reg_write(reg.UC_ARM_REG_R1,0x610f0000);c.reg_write(reg.UC_ARM_REG_R8,r8)
        c.reg_write(reg.UC_ARM_REG_LR,0x620ff000);c.emu_start(e['softFocusRow'],0x620ff000,count=50)
        assert c.reg_read(reg.UC_ARM_REG_R8)==(0x610f0000+22*r8 if r8<9 else rows+22*(r8-9));calls+=1
    gains=struct.unpack('<33h',c.mem_read(rows,66))
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,function=FN,text=text,icon=icon,
        soft_focus_rows=[list(gains[i*11:i*11+11]) for i in range(3)],names_all_21_rows=True,other_functions_unchanged=True,
        movie_layout_unchanged=True,one_current_value_always=True,menu_all_five_slots=True,
        look20_unchanged=True,off_unless_on_an_adj_slot=True,hardware_tested=False,
        scope='ADJ controller, ADJ mode setting menu, picture decision, effect parameter and row helper; widgets substituted.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
