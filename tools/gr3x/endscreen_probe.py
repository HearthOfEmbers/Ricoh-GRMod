"""Round 6: power-off pictures chosen as on GR IV (core/src/fw/gr3x/endscreen.ts,
tools/gr3x/native/endscreen.c), every patch of the manifest installed:

  - texts and icons: Type / Picture in all 21 rows (GR IV's names), "Original" per row, the names;
    520 x 200 thumbnails of the five factory pictures and of every added picture;
  - Setup menu: the table's Setup entry points at a copy of the official descriptor that differs only
    in End Screen's draw function and id (the submenu); that line draws no value and End Screen's title;
  - submenu: SubMenuController::SetCurrentMenu selects its record (after the date imprint's) whose
    title, lines, ids and draw functions are checked; the Type line shows the native End Screen
    value text, the Picture line the current choice's name;
  - factory and key map: the submenu gets D-Range's submenu controller and keys, the picture list
    the End Screen list (mode 1), End Screen itself the End Screen list (mode 0), every other id
    itself with the mode untouched;
  - the End Screen list (GoodByeDisplaySetController) in both modes, its handlers run through the
    patched entries: in the camera's mode refresh / confirm / up / down / footer make exactly the
    widget calls and settings writes of the unpatched image (plus the shown rows, title and visible
    footer the refresh stub sets); in picture mode 1 + n rows with their texts and one tick on the
    choice, the cursor on it, OK storing the picture's identity in all eight record copies, up / down
    with key repeat stops, the footer thumbnail of every row and camera variant;
  - the rows: the list is built with 1 + n rows of type 0x15;
  - the power-off picture: RequestBackgroundJpeg (0x5319f180) for every camera variant asks for the
    native picture unless a known picture identity is stored (stale identities, round 5's picture
    numbers and no record give the native one), then for 13 + its row; the request's table holds the
    13 official pointers and n entries {720, 480, "A:\\Resource\\Jpeg\\GRMODk.jpg"}.
UI widgets and singletons are substitutes; the camera's display, keys and files are not executed.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from shutdown_probe import PictureProbe,REQUEST,NATIVE_INDEX,ORIGINAL
from datestamp_probe import u32,movw,ret,STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

MENU_ID,LIST_ID,END_ID,D_RANGE=0x020001a3,0x020001a4,0x020000ad,0x020000ba
MODE=0x5580437c;UD=0x55063f30
SETUP,SETUP_ENTRY_IMAGE=0x53b36a54,0x5407d408
FACTORY,KEYREAD,SUB_SETCUR,SUB_TABLE=0x5316f3b8,0x53221a4c,0x531c5950,0x53b3fb10
REFRESH,CONFIRM,UP,DOWN,FOOTER,BUILD=0x532049fc,0x532048c4,0x53204834,0x53204878,0x53204ab0,0x532044c0
W={0x53394820:'selected',0x53394758:'item',0x53395430:'focus',0x53395260:'move',0x5339e738:'check',0x5339e7a0:'text',
   0x5339a9a0:'icon',0x533ad3c0:'visible',0x53394e8c:'shown',0x533a2ba0:'title',0x533a6ad0:'line_text',0x5339de20:'value_icon',
   0x5339dc70:'top_title',0x53394610:'build',0x5339de6c:'value_text'}
TYPE=['タイプ','Type','Type','Typ','Tipo','Tipo','Tipo','Type','Type','Typ','Tyyppi','Typ','Typ','Típus','Tip','Τύπος','Тип','유형','類型','类型','แบบ']
PICTURE=['画像','Picture','Image','Bild','Imagen','Imagem','Immagine','Afbeelding','Billede','Bild','Kuva','Obraz','Obrázek','Kép','Resim','Εικόνα','Изображение','이미지','圖片','图片','ภาพ']
CTL,LIST,GRAPHIC,TVIEW=0x62070000,0x62071000,0x62072000,0x62073000
RECS=[0x62080000+i*0x1000 for i in range(8)]

class EndProbe(PictureProbe):
    """The patched image (or, with a base manifest, the official code) with widget substitutes."""
    def __init__(s,data,manifest):
        super().__init__(data,manifest);s.calls=[];s.selected=0
        try:s.uc.mem_map(0x62070000,0x20000)
        except Exception:pass
    def _hook(s,cpu,at,size,user):
        R=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R%d'%n))
        if at in W:
            s.calls.append((W[at],R(0),R(1),R(2)))
            ret(cpu,s.selected if W[at]=='selected' else 0x62074000 if W[at]=='item' else 1 if W[at] in ('build',) else 0)
        elif at==0x5320b31c:ret(cpu,UD)
        else:PictureProbe._hook(s,cpu,at,size,user)
    def records(s,choice=None,byte=None,end=0):
        for r in RECS:
            s.uc.mem_write(r,bytes(0xb28));s.uc.mem_write(r+0xaae,bytes([end]))
            if choice is not None:s.uc.mem_write(r+0x9a9,bytes([choice&255,(choice>>8)&255,(choice>>16)&255]));s.uc.mem_write(r+0x9a3,bytes([choice>>24]))
            if byte is not None:s.uc.mem_write(r+0x9a3,bytes([byte]))
        s.uc.mem_write(UD,struct.pack('<9I',0,*RECS))
    def stored(s):
        out=[]
        for r in RECS:
            b=bytes(s.uc.mem_read(r,0xb28));out.append(b[0x9a9]|b[0x9aa]<<8|b[0x9ab]<<16|b[0x9a3]<<24)
        return out
    def controller(s,mode):
        s.uc.mem_write(CTL,bytes(0x200));s.uc.mem_write(CTL+0x15c,struct.pack('<4I',TVIEW,0,GRAPHIC,LIST))
        s.uc.mem_write(MODE,struct.pack('<I',mode))

def verify(data,manifest):
    e=manifest['entries'];ids=manifest['pictures'];assert ids and ids['form']=='submenu'
    n=ids['count'];p=EndProbe(data,manifest);c=p.uc;calls=0;report={}
    orig=lambda a,k:data[a-0x53000000:a-0x53000000+k]
    roots=manifest['catalogs']['textRoots']
    def text(row,tid):
        rec=u32(c,u32(c,roots+row*4)+tid*4);units,lines,_,at=struct.unpack('<BBHI',bytes(c.mem_read(rec,8)))
        assert lines==1;return bytes(c.mem_read(at,units*2)).decode('utf-16le')[:-1]
    # 1. Texts and thumbnails.
    for row in range(21):
        assert text(row,ids['typeText'])==TYPE[row] and text(row,ids['pictureText'])==PICTURE[row] and text(row,ids['factoryText'])==ORIGINAL[row]
    names=[text(1,t) for t in ids['names']];assert ids['names']==[ids['factoryText']+1+k for k in range(n)]
    for row in range(21):assert [text(row,t) for t in ids['names']]==names
    origin=manifest['iconAddition']['originalLength'];icons=bytes.fromhex(manifest['iconAddition']['bytes'])
    for t in ids['factoryIcons']+ids['icons']:
        w,h,o=struct.unpack('<HHI',bytes(c.mem_read(u32(c,manifest['catalogs']['iconRoot']+t*4),8)))
        assert (w,h)==(520,200) and o*4>=origin and o*4-origin+520*200*4<=len(icons)
        px=icons[o*4-origin:o*4-origin+520*200*4];assert all(px[i]==255 for i in range(3,len(px),4*97))
    # 2. Setup menu: only End Screen's draw and id differ.
    copy=u32(c,SETUP_ENTRY_IMAGE);assert copy!=SETUP and copy==e['endScreenSetupMenu']
    official=orig(SETUP,0x384);d=bytes(c.mem_read(copy,0x384))
    diff=[i for i in range(0x384) if d[i]!=official[i]]
    assert set(diff)<=set(range(0x8c+10*8,0x8c+10*8+4))|set(range(0x1bc+40,0x1bc+44))
    assert struct.unpack_from('<I',d,0x8c+80)[0]==e['endScreenSetupLine'] and struct.unpack_from('<I',d,0x1bc+40)[0]==MENU_ID
    p.calls=[];p.call(e['endScreenSetupLine'],0x62056000,0x6205b000);calls+=1
    assert [x[:3] for x in p.calls]==[('value_icon',0x6205b000,0),('top_title',0x6205b000,665)] and p.calls[1][3]==665
    # 3. Submenu record and its SetCurrentMenu.
    table=e['submenuTable'];obj=0x62059000
    c.mem_write(obj,bytes(0x200));p.call(SUB_SETCUR,obj,MENU_ID);calls+=1
    rec_no=c.mem_read(obj+0x174,1)[0];assert rec_no in (18,19)
    rec=bytes(c.mem_read(table+rec_no*0x64,0x64));drange=orig(SUB_TABLE+6*0x64,0x64)
    want=bytearray(drange);struct.pack_into('<H',want,2,665);struct.pack_into('<HH',want,8,ids['typeText'],ids['pictureText'])
    struct.pack_into('<II',want,0x14,END_ID,LIST_ID);struct.pack_into('<4I',want,0x3c,e['endScreenLineType'],0,e['endScreenLinePicture'],0)
    assert rec==bytes(want)
    for end in (0,1):
        p.records(end=end);p.calls=[];p.call(e['endScreenLineType'],0x62056000,0x6205b000);calls+=1
        lt=[x for x in p.calls if x[0]=='line_text'];assert len(lt)==1 and lt[0][1]==0x6205b000
        native=p.call(0x53293164,0x62049000,end);assert lt[0][2]==native and native,(end,lt,native)
    for k in [-1]+list(range(n)):
        p.records(choice=ids['choices'][k] if k>=0 else 0);p.calls=[];p.call(e['endScreenLinePicture'],0x62056000,0x6205b000);calls+=1
        assert p.calls==[('line_text',0x6205b000,ids['factoryText']+1+k,p.calls[0][3])]
    # 4. Factory and key map.
    for cid in (MENU_ID,LIST_ID,END_ID,D_RANGE,0x020001a0,0x020001a1,0x020001a5,0x0200007d,0x08000000,0x020000ac):
        for start in (0,1):
            c.mem_write(MODE,struct.pack('<I',start+0x100))
            c.reg_write(reg.UC_ARM_REG_R0,0x62056000);c.reg_write(reg.UC_ARM_REG_R1,cid);c.reg_write(reg.UC_ARM_REG_SP,STACK)
            c.emu_start(FACTORY,FACTORY+4,count=200)
            want={MENU_ID:D_RANGE,LIST_ID:END_ID}.get(cid,cid)
            if cid in (0x020001a0,):want=D_RANGE if manifest.get('dateImprint',{}) and manifest['dateImprint'].get('form')=='submenu' else 0x0200007d
            if cid in (0x020001a1,) and manifest.get('dateImprint',{}) and manifest['dateImprint'].get('form')=='submenu':want=0x0200007d
            assert c.reg_read(reg.UC_ARM_REG_R1)==want and c.reg_read(reg.UC_ARM_REG_R3)==0x13b,hex(cid)
            assert c.reg_read(reg.UC_ARM_REG_R0)==0x62056000 and c.reg_read(reg.UC_ARM_REG_SP)==STACK
            mode=u32(c,MODE);assert mode=={LIST_ID:1,END_ID:0}.get(cid,start+0x100),(hex(cid),mode)
            c.mem_write(0x62057000,struct.pack('<I',cid))
            assert p.call(e['dateKeys'],0x62057000)==want;calls+=2
    # 5. The list in the camera's own mode: as the official code (twin: the official image).
    # The twin: the same build with the five handlers' official first words back (the unpatched code).
    twin=EndProbe(data,manifest)
    for at in (REFRESH,FOOTER,UP,DOWN,CONFIRM):twin.uc.mem_write(at,orig(at,4))
    for end in (0,1):
        for sel in (0,1):
            outs=[]
            for probe,patched in ((p,True),(twin,False)):
                probe.records(end=end);probe.controller(0);probe.selected=sel;probe.calls=[]
                for fn,args in ((REFRESH,()),(FOOTER,()),(UP,(0,)),(UP,(1,)),(DOWN,(0,)),(DOWN,(1,)),(CONFIRM,())):
                    probe.call(fn,CTL,*args)
                outs.append((probe.calls,[bytes(probe.uc.mem_read(r+0xaae,1)) for r in RECS],probe.stored()))
            pc,tc=outs[0][0],outs[1][0]
            extra=[('shown',LIST,2),('title',TVIEW,665),('visible',GRAPHIC,1)]
            assert [x[:3] for x in pc[:3]]==extra and pc[3:]==tc,(end,sel)
            assert outs[0][1:]==outs[1][1:];calls+=14
    # 6. Picture mode.
    rows=1+n
    for k in [-1]+list(range(n)):
        choice=ids['choices'][k] if k>=0 else 0;chosen=k+1
        p.records(choice=choice);p.controller(1);p.calls=[];p.call(REFRESH,CTL);calls+=1
        assert p.calls[:2]==[('shown',LIST,rows,p.calls[0][3]),('title',TVIEW,ids['pictureText'],p.calls[1][3])]
        body=[x[:3] for x in p.calls[2:]]
        wantb=[]
        for r in range(rows):wantb+=[('item',LIST,r),('check',0x62074000,int(r==chosen)),('text',0x62074000,ids['factoryText']+r)]
        wantb.append(('focus',LIST,chosen));assert body==wantb,(k,body)
        for sel in range(rows+1):
            p.records(choice=choice);p.controller(1);p.selected=sel;p.calls=[];r0=p.call(CONFIRM,CTL);calls+=1
            assert r0==1
            st=p.stored()
            if sel<rows:assert st==[0 if sel==0 else ids['choices'][sel-1]]*8,(sel,st)
            else:assert st==[choice]*8
            assert all(u32(c,r+0xaac)&0xff0000==0 for r in RECS)   # End Screen type untouched
    for sel in range(rows):
        for stop in (0,1):
            p.controller(1);p.selected=sel;p.calls=[];p.call(UP,CTL,stop);calls+=1
            assert [x[:2] for x in p.calls]==[('selected',LIST)]+([] if sel==0 and stop else [('move',LIST)]),p.calls
            assert sel==0 and stop or p.calls[1][2:]==(0xffffffff,1)
            p.calls=[];p.call(DOWN,CTL,stop);calls+=1
            assert [x[:2] for x in p.calls]==[('selected',LIST)]+([] if sel==rows-1 and stop else [('move',LIST)]),p.calls
            assert sel==rows-1 and stop or p.calls[1][2:]==(1,1)
        for variant in range(5):
            p.variant=variant;p.controller(1);p.selected=sel;p.calls=[];p.call(FOOTER,CTL);calls+=1
            icon=ids['factoryIcons'][variant] if sel==0 else ids['icons'][sel-1]
            assert [x[:2] for x in p.calls]==[('selected',LIST),('icon',GRAPHIC),('visible',GRAPHIC)] and p.calls[1][2]==icon and p.calls[2][2]==1,(sel,variant,p.calls)
    # 7. Rows of the list.
    # Run the row builder up to its widget call (0x53204504) and the instruction after it.
    p.controller(0);p.calls=[]
    c.reg_write(reg.UC_ARM_REG_R0,CTL);c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP)
    c.emu_start(BUILD,0x53204508,count=200);assert c.reg_read(reg.UC_ARM_REG_PC)==0x53204508
    b=[x for x in p.calls if x[0]=='build'][0]
    assert b[1]==LIST and b[3]==max(2,rows) and b[2]==e['endScreenTypes'],b
    assert bytes(c.mem_read(e['endScreenTypes'],max(2,rows)))==bytes([0x15])*max(2,rows)
    # 8. The power-off picture.
    lo_,hi_=u32(c,0x5322e4b4),u32(c,0x5322e4bc)
    jt=((lo_&0xfff)|((lo_>>4)&0xf000))|(((hi_&0xfff)|((hi_>>4)&0xf000))<<16)
    assert jt==e['pictureTable'] and bytes(c.mem_read(jt,13*4))==orig(0x5407e0b8,13*4)
    for k in range(n):
        ent=u32(c,jt+(13+k)*4);w,h,path=struct.unpack('<HHI',bytes(c.mem_read(ent,8)))
        assert (w,h)==(720,480) and bytes(c.mem_read(path,40)).split(b'\0')[0]==f'A:\\Resource\\Jpeg\\GRMOD{k+1}.jpg'.encode()
    cases=0
    for variant in range(5):
        for state in [('none',None,None),('stale',0x55aa55,None),('round5',None,1),('round5',None,n)]+[('pick',k,None) for k in range(n)]:
            kind,v,byte=state
            if kind=='pick':p.records(choice=ids['choices'][v])
            elif kind=='stale':p.records(choice=v)
            else:p.records(choice=None,byte=byte)
            p.variant=variant;p.requests=[];p.call(REQUEST,0x62056000);calls+=1;cases+=1
            assert len(p.requests)==1 and p.requests[0][0]==0x6205e000
            want=13+v if kind=='pick' else NATIVE_INDEX[variant]
            assert p.requests[0][1]==want,(variant,state,p.requests[0][1])
        c.mem_write(UD+4,bytes(4));p.variant=variant;p.requests=[];p.call(REQUEST,0x62056000);calls+=1
        assert p.requests[0][1]==NATIVE_INDEX[variant]
    report.update(pictures=n,names=names,request_cases=cases,record_copies=8)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,**report,hardware_tested=False,
        scope='Patched Setup copy, submenu record, factory, key map, End Screen list handlers in both modes against the unpatched code, picture request and JPEG table; widgets and singletons substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();result=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
