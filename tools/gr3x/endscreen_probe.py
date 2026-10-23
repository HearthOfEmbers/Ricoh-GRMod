"""Round 6: power-off pictures chosen in the End Screen submenu (core/src/fw/gr3x/endscreen.ts,
tools/gr3x/native/endscreen.c), every patch of the manifest installed, against the official image:

  - texts and icons: Type / Picture / Original in all 21 rows, the names; 520 x 200 thumbnails of
    the five factory pictures and of the added ones;
  - Setup: the table's Setup entry points at a copy of the official descriptor whose only change
    is item 10 (End Screen) opening the submenu, drawn as a submenu line (no value, title 665);
  - the submenu record (D-Range's with title 665, Type / Picture, their ids and line draws) and
    SetCurrentMenu for its id; factory: submenu -> D-Range's submenu controller, picture list ->
    End Screen (mode 1), End Screen -> End Screen (mode 0), every other id and the mode unchanged;
    the key map likewise;
  - the End Screen list in the camera's own mode: refresh, confirm, up / down and footer do what
    the official code does (run on the official image with the same substitutes), after the mode's
    row count and title; the list is built with 1 + n rows of type 0x15;
  - in picture mode: refresh (rows, ticks, texts, cursor on the choice), confirm on every row (the
    identity written to all eight copies of the record, every other byte unchanged), up / down at
    the ends with and without key repeat, the footer's thumbnail for every row and camera
    variant, the Type and Picture lines;
  - the power-off picture for every camera variant and stored value (none, each picture, an
    unknown identity, round 5's picture numbers, no record): the chosen picture's table number,
    else the camera's own; the table copied with the pictures.
UI widgets and singletons are substitutes; the camera's menus, keys and display are not executed.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from shutdown_probe import PictureProbe,REQUEST,NATIVE_INDEX,VOBJ
from rear_dial_probe import RearDialProbe
from datestamp_probe import u32,movw,ret
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

MENU_ID,LIST_ID,END_SCREEN,D_RANGE=0x020001a3,0x020001a4,0x020000ad,0x020000ba
MODE=0x5580437c
UD=0x55063f30;RECS=[0x62058000+0x1000*i for i in range(8)]
SETUP,SETUP_ENTRY_IMAGE=0x53b36a54,0x5407d408
FACTORY,KEYREAD,SUB_SETCUR=0x5316f3b8,0x53221a4c,0x531c5950
SUB_TABLE=0x53b3fb10
SUB_SITES=[(0x531c5d18,0x531c5d20,3),(0x531c5d80,0x531c5d88,2),(0x531c60e8,0x531c60f4,8),(0x531c6318,0x531c631c,5),(0x531c63e4,0x531c63f0,3)]
REFRESH,CONFIRM,UP,DOWN,FOOTER,BUILD=0x532049fc,0x532048c4,0x53204834,0x53204878,0x53204ab0,0x532044c0
W={0x53394820:'selected',0x53394758:'item',0x53395430:'focus',0x53395260:'move',0x5339e738:'check',0x5339e7a0:'text',
   0x5339a9a0:'icon',0x533ad3c0:'visible',0x53394e8c:'shown',0x533a2ba0:'title',0x533a6ad0:'line',0x5339de20:'value',0x5339dc70:'tl',
   0x53394610:'build'}
TEXT_OF=0x53293164
TYPES=['タイプ','Type','Type','Typ','Tipo','Tipo','Tipo','Type','Type','Typ','Tyyppi','Typ','Typ','Típus','Tip','Τύπος','Тип','유형','類型','类型','แบบ']
PICTURES=['画像','Picture','Image','Bild','Imagen','Imagem','Immagine','Afbeelding','Billede','Bild','Kuva','Obraz','Obrázek','Kép','Resim','Εικόνα','Изображение','이미지','圖片','图片','ภาพ']
ORIGINAL=['オリジナル']+['Original']*17+['原始','原始','Original']
CTL,LIST,GRAPH,TVIEW,CHILD=0x62070000,0x62071000,0x62072000,0x62073000,0x62074000

class Ui:
    """Widget substitutes shared by the patched and the official image."""
    def ui_hook(s,cpu,at):
        R=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R%d'%n))
        if at in W:
            name=W[at];s.log.append((name,R(0),R(1),R(2)) if name in ('move','build','tl') else (name,R(0),R(1)))
            v=s.selected if name=='selected' else CHILD if name=='item' else 0
            if name=='build':s.built=(R(2),bytes(cpu.mem_read(R(1),R(2))))
            ret(cpu,v);return True
        if at==TEXT_OF:s.log.append(('textof',R(1)));ret(cpu,0x7000+R(1));return True
        if at==0x5320b31c:ret(cpu,UD);return True
        return False
    def controller(s):
        c=s.uc;c.mem_write(CTL,bytes(0x200))
        for off,v in ((0x15c,TVIEW),(0x164,GRAPH),(0x168,LIST)):c.mem_write(CTL+off,struct.pack('<I',v))
    def records(s,choice=None,aae=0,raw=None,pointers=True):
        c=s.uc
        for i,r in enumerate(RECS):
            data=bytearray((i*31+j*7)&0xff for j in range(0xb28))
            data[0xaae]=aae
            if choice is not None:data[0x9a9:0x9ac]=struct.pack('<I',choice)[:3];data[0x9a3]=choice>>24
            if raw:
                for off,b in raw.items():data[off]=b
            c.mem_write(r,bytes(data))
            c.mem_write(UD+4+4*i,struct.pack('<I',r if pointers else 0))
    def snapshot(s):return [bytes(s.uc.mem_read(r,0xb28)) for r in RECS]
    def run(s,at,*args):
        s.log=[];c=s.uc
        for i in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        for i,v in enumerate(args):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        for i in range(4,12):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0x12340000+i)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP);c.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        c.emu_start(at,STOP,count=200000)
        assert c.reg_read(reg.UC_ARM_REG_PC)==STOP and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        assert [c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(4,12)]==[0x12340000+i for i in range(4,12)]
        return c.reg_read(reg.UC_ARM_REG_R0)

class Patched(Ui,PictureProbe):
    def __init__(s,data,manifest):
        PictureProbe.__init__(s,data,manifest);s.log=[];s.selected=0;s.built=None
    def _hook(s,cpu,at,size,user):
        if not s.ui_hook(cpu,at):PictureProbe._hook(s,cpu,at,size,user)

class Official(Ui,RearDialProbe):
    def __init__(s,data):
        RearDialProbe.__init__(s,data);s.log=[];s.selected=0;s.built=None
        s.uc.mem_map(0x5503b000,0x55900000-0x5503b000)
    def _hook(s,cpu,at,size,user):
        if not s.ui_hook(cpu,at):RearDialProbe._hook(s,cpu,at,size,user)

def verify(data,manifest):
    e=manifest['entries'];ids=manifest['pictures'];assert ids and ids['form']=='submenu'
    n=ids['count'];p=Patched(data,manifest);o=Official(data);c=p.uc;calls=0;report={}
    orig=lambda a,k:data[a-0x53000000:a-0x53000000+k]
    choices=ids['choices'];assert len(set(choices))==n and all(1<=x<=0xffffffff for x in choices)
    # 1. Texts and icons.
    roots=manifest['catalogs']['textRoots']
    def text(row,tid):
        rec=u32(c,u32(c,roots+row*4)+tid*4);units,lines,_,at=struct.unpack('<BBHI',bytes(c.mem_read(rec,8)))
        assert lines==1;return bytes(c.mem_read(at,units*2)).decode('utf-16le')[:-1]
    for row in range(21):
        assert [text(row,ids['typeText']),text(row,ids['pictureText']),text(row,ids['factoryText'])]==[TYPES[row],PICTURES[row],ORIGINAL[row]]
        assert [text(row,ids['factoryText']+1+k) for k in range(n)]==[text(1,ids['factoryText']+1+k) for k in range(n)]
    names=[text(1,ids['factoryText']+1+k) for k in range(n)]
    origin=manifest['iconAddition']['originalLength'];icons=bytes.fromhex(manifest['iconAddition']['bytes'])
    for t in ids['factoryIcons']+ids['icons']:
        w,h,off=struct.unpack('<HHI',bytes(c.mem_read(u32(c,manifest['catalogs']['iconRoot']+t*4),8)))
        assert (w,h)==(520,200) and off*4>=origin and off*4-origin+520*200*4<=len(icons)
        px=icons[off*4-origin:off*4-origin+416000];assert all(px[i]==255 for i in range(3,416000,4*97))
    # 2. Setup.
    copy=u32(c,SETUP_ENTRY_IMAGE);assert copy==e['endScreenSetupMenu'] and orig(SETUP_ENTRY_IMAGE,4)==struct.pack('<I',SETUP)
    want=bytearray(orig(SETUP,0x384));struct.pack_into('<I',want,0x8c+10*8,e['endScreenSetupLine']);struct.pack_into('<I',want,0x1bc+10*4,MENU_ID)
    assert bytes(c.mem_read(copy,0x384))==bytes(want)
    p.log=[];p.run(e['endScreenSetupLine'],0x62056000,0x6205b000);calls+=1
    assert p.log==[('value',0x6205b000,0),('tl',0x6205b000,665,665)],p.log
    # 3. Submenu record, SetCurrentMenu, factory, key map.
    st=None
    for lo,hi,r in SUB_SITES:
        a,b=u32(c,lo),u32(c,hi);va=(a&0xfff)|((a>>4)&0xf000)|(((b&0xfff)|((b>>4)&0xf000))<<16)
        assert a==movw(r,va&0xffff) and b==movw(r,va>>16,True);st=st or va;assert va==st
    obj=0x62059000;c.mem_write(obj,bytes(0x200));p.call(SUB_SETCUR,obj,MENU_ID);idx=c.mem_read(obj+0x174,1)[0];calls+=1
    assert idx==(19 if manifest.get('dateImprint') and manifest['dateImprint'].get('form')=='submenu' else 18)
    rec=bytes(c.mem_read(st+idx*0x64,0x64));tpl=bytearray(orig(SUB_TABLE+6*0x64,0x64))
    struct.pack_into('<H',tpl,2,665);struct.pack_into('<HH',tpl,8,ids['typeText'],ids['pictureText'])
    struct.pack_into('<II',tpl,0x14,END_SCREEN,LIST_ID);struct.pack_into('<4I',tpl,0x3c,e['endScreenLineType'],0,e['endScreenLinePicture'],0)
    assert rec==bytes(tpl)
    others=[0x02000077,0x0200007d,D_RANGE,0x020001a0,0x020001a1,0x020001a2,0x020001a5,0x08000000,0x020000ac,0x020000ae]
    date=manifest.get('dateImprint')
    mapped={MENU_ID:D_RANGE,LIST_ID:END_SCREEN,**({0x020001a0:D_RANGE,0x020001a1:0x0200007d,0x020001a2:0x0200007d} if date and date.get('form')=='submenu' else {0x020001a0:0x0200007d} if date else {})}
    for cid in [MENU_ID,LIST_ID,END_SCREEN]+others:
        for before in (0,1,0x5a):
            c.mem_write(MODE,struct.pack('<I',before))
            c.reg_write(reg.UC_ARM_REG_R0,0x62056000);c.reg_write(reg.UC_ARM_REG_R1,cid);c.reg_write(reg.UC_ARM_REG_SP,STACK)
            c.emu_start(FACTORY,FACTORY+4,count=200)
            want=mapped.get(cid,cid)
            assert c.reg_read(reg.UC_ARM_REG_R1)==want and c.reg_read(reg.UC_ARM_REG_R3)==0x13b and c.reg_read(reg.UC_ARM_REG_R0)==0x62056000,hex(cid)
            mode=u32(c,MODE);assert mode=={LIST_ID:1,END_SCREEN:0}.get(cid,before),(hex(cid),before,mode)
            calls+=1
        c.mem_write(0x62057000,struct.pack('<I',cid))
        assert p.call(e['dateKeys'],0x62057000)==mapped.get(cid,cid),hex(cid);calls+=1
    # 4. The list's rows (1 + n, type 0x15) as it is built.
    p.controller();p.log=[];p.built=None
    cc=p.uc;cc.reg_write(reg.UC_ARM_REG_R0,CTL);cc.reg_write(reg.UC_ARM_REG_SP,STACK);cc.reg_write(reg.UC_ARM_REG_LR,STOP)
    cc.emu_start(BUILD,0x53204508,count=200);assert p.built==(max(2,1+n),bytes([0x15])*max(2,1+n)),p.built;calls+=1
    # 5. Own mode: the official handlers after the mode's row count and title (footer graphic shown).
    own=0
    for aae in (0,1):
        for row in (0,1):
            for stop in (0,1):
                for probe in (p,o):
                    probe.controller();probe.records(choice=choices[0],aae=aae);probe.selected=row
                    probe.uc.mem_write(MODE,bytes(4))
                logs={}
                for name,at,args in (('refresh',REFRESH,(CTL,)),('up',UP,(CTL,stop)),('down',DOWN,(CTL,stop)),('footer',FOOTER,(CTL,)),('confirm',CONFIRM,(CTL,))):
                    rp=p.run(at,*args);ro=o.run(at,*args);calls+=2
                    pre=[('shown',LIST,2),('title',TVIEW,665),('visible',GRAPH,1)] if name=='refresh' else []
                    assert p.log==pre+o.log,(name,p.log,o.log)
                    assert rp==ro and p.snapshot()==o.snapshot(),name
                    own+=1
    report['own_mode_cases']=own
    # 6. Picture mode.
    p.uc.mem_write(MODE,struct.pack('<I',1))
    pic=0
    for stored in [None,0]+choices+[0xdeadbeef,1<<24,8<<24]:
        chosen=1+choices.index(stored) if stored in choices else 0
        p.controller();p.records(choice=stored);before=p.snapshot()
        p.run(REFRESH,CTL);calls+=1
        rows=[('shown',LIST,1+n),('title',TVIEW,ids['pictureText'])]
        for r in range(1+n):rows+= [('item',LIST,r),('check',CHILD,int(r==chosen)),('text',CHILD,ids['factoryText']+r)]
        rows.append(('focus',LIST,chosen))
        assert p.log==rows,(stored,p.log)
        assert p.snapshot()==before
        # The Picture line: the current choice's name; the Type line: the camera's value text.
        p.run(e['endScreenLinePicture'],0x62056000,0x6205b000);assert p.log==[('line',0x6205b000,ids['factoryText']+chosen)];calls+=1
        for aae in (0,1):
            p.records(choice=stored,aae=aae);p.run(e['endScreenLineType'],0x62056000,0x6205b000);calls+=1
            assert p.log==[('textof',aae),('line',0x6205b000,0x7000+aae)],p.log
        # Confirm each row: the identity in all eight copies (bytes 0x9a9..0x9ab, 0x9a3), nothing else.
        for row in range(1+n):
            p.records(choice=stored);p.selected=row;before=p.snapshot()
            assert p.run(CONFIRM,CTL)==1;calls+=1
            want=0 if row==0 else choices[row-1]
            for b,a in zip(before,p.snapshot()):
                exp=bytearray(b);exp[0x9a9:0x9ac]=struct.pack('<I',want)[:3];exp[0x9a3]=want>>24
                assert a==bytes(exp)
            assert [x for x in p.log if x[0] in ('check','text')]==[y for r in range(1+n) for y in (('check',CHILD,int(r==row)),('text',CHILD,ids['factoryText']+r))]
            pic+=1
        # Up / down at every row, with and without key repeat.
        for row in range(1+n):
            for stop in (0,1):
                p.selected=row;p.run(UP,CTL,stop);calls+=1
                assert [x for x in p.log if x[0]=='move']==([] if row==0 and stop else [('move',LIST,0xffffffff,1)])
                p.selected=row;p.run(DOWN,CTL,stop);calls+=1
                assert [x for x in p.log if x[0]=='move']==([] if row==n and stop else [('move',LIST,1,1)])
        # Footer: the focused row's thumbnail; the factory row by camera variant.
        for variant in range(6):
            p.variant=variant
            for row in range(1+n):
                p.selected=row;p.run(FOOTER,CTL);calls+=1
                icon=ids['factoryIcons'][variant if variant<5 else 0] if row==0 else ids['icons'][row-1]
                assert [x for x in p.log if x[0] in ('icon','visible')]==[('icon',GRAPH,icon),('visible',GRAPH,1)],(variant,row,p.log)
    # No record at all: the factory picture, nothing written.
    p.controller();p.records(choice=choices[0],pointers=False);p.selected=1
    assert p.run(CONFIRM,CTL)==1;p.run(REFRESH,CTL);assert ('check',CHILD,1) in p.log and p.log[-1]==('focus',LIST,0);calls+=2
    report['picture_mode_cases']=pic
    # 7. The power-off picture.
    jt_lo,jt_hi=u32(c,0x5322e4b4),u32(c,0x5322e4bc);jt=(jt_lo&0xfff)|((jt_lo>>4)&0xf000)|(((jt_hi&0xfff)|((jt_hi>>4)&0xf000))<<16)
    assert jt==e['pictureTable'] and bytes(c.mem_read(jt,13*4))==orig(0x5407e0b8,13*4)
    for k in range(n):
        ent=u32(c,jt+(13+k)*4);w,h,path=struct.unpack('<HHI',bytes(c.mem_read(ent,8)))
        assert (w,h)==(720,480) and bytes(c.mem_read(path,40)).split(b'\0')[0]==f'A:\\Resource\\Jpeg\\GRMOD{k+1}.jpg'.encode()
    seen=0
    for variant in range(5):
        for stored,pointer in [(None,True),(0,True),(0xdeadbeef,True),(1<<24,True),(3<<24,True),(choices[0],False)]+[(x,True) for x in choices]:
            p.variant=variant;p.records(choice=stored,pointers=pointer);p.requests=[];p.call(REQUEST,0x62056000);calls+=1
            assert len(p.requests)==1
            want=13+choices.index(stored) if pointer and stored in choices else NATIVE_INDEX[variant]
            assert p.requests[0][1]==want and p.requests[0][0]==0x6205e000,(variant,stored,pointer,p.requests)
            seen+=1
    report['picture_requests']=seen
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,pictures=n,names=names,**report,hardware_tested=False,
        scope='Patched Setup copy, submenu record, factory, key map, End Screen list handlers in both modes (own mode against the official image), GoodBye picture request and JPEG table; UI widgets, singletons and the JPEG request substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();result=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
