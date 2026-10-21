"""Own film parameters (T6d): execute the installed module through the camera's own code.

The three native "look of photo set n" setters run patched; their record push (0x532750f8) is
recorded, not executed. The settings load/save, the record store and the allocator are
substitutes; the extended start-up zero fill runs natively. A seeded random sequence of look
changes, parameter edits and power cycles is checked against a Python model in which every look
has its own values. This does not establish flash persistence or the camera's menus.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import UC_HOOK_MEM_WRITE
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

STYLE_SETTERS=(0x5327b394,0x5327b3b4,0x5327b3d4)
PUSH,LOAD_DATA,LOAD_CALL,SAVE_DATA,SAVE_CALL=0x532750f8,0x5324b284,0x5324b754,0x5323f274,0x5322b0a8
SINGLETON,WRITE,READ,SIZE,ALLOC=0x53828014,0x53829a08,0x53829fcc,0x53829e50,0x536af2a8
FILL_LOAD,FILL_END,GAP,HEAP=0x530003ac,0x530003c8,0x55804374,0x55804380
REGION=0x63000000;UD=REGION;REC=REGION+0x1000;FACTORY=REGION+0x3000;HT=REGION+0x3100;HEAPAREA=REGION+0x10000
FIELDS=(0x1c8,0x1d4,0x1e0,0x1f2,0x204,0x216,0x228,0x278,0x28a);STRIDE=0xe2
LOOKS=list(range(11,23))+list(range(64,73))
REC_WORDS=3+68+1

def field(j,s):return FIELDS[j]+s*STRIDE
def owner_of(look):return 0 if look==11 else look-63 if 64<=look<=72 else None
def checksum(words):
    total=0x6a09e667
    for i,w in enumerate(words):total=(((total^w)*0x01000193)+i)&0xffffffff
    return total

class SlotsProbe(AdjProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest)
        own=manifest['lookEntries']['ownParameters']
        self.own=own
        self.uc.mem_map(0x55800000,0x100000)
        self.uc.mem_map(REGION,0x100000)
        self.store={};self.writes=[];self.pushes=[];self.allocs=[];self.alloc_ok=True;self.singleton_ok=True
        self.loads=self.saves=0;self.next_heap=HEAPAREA;self.allowed=set()
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self._record_write,begin=REC,end=REC+0xb28)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self._gap_write,begin=GAP,end=HEAP+3)
        self.rec_writes=[]
    def _record_write(self,cpu,access,at,size,value,user):self.rec_writes.append((at-REC,size))
    def _gap_write(self,cpu,access,at,size,value,user):
        assert at==GAP and size==4 or self.filling,(hex(at),size)
    filling=False
    def _ret(self,cpu,value):
        cpu.reg_write(reg.UC_ARM_REG_R0,value);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at==PUSH:
            rec=struct.unpack('<I',cpu.mem_read(r(0)+4,4))[0]
            self.pushes.append(bytes(cpu.mem_read(rec,0xb28)));self._ret(cpu,0)
        elif at==SINGLETON:self._ret(cpu,FACTORY if self.singleton_ok else 0)
        elif at in (WRITE,READ,SIZE):
            assert r(0)==HT and r(1)==12,(hex(at),hex(r(0)),r(1))
            if at==SIZE:self._ret(cpu,len(self.store.get(12,b'')))
            elif at==READ:
                data=self.store.get(12)
                if data is None:self._ret(cpu,0)
                else:
                    n=min(r(2),len(data));cpu.mem_write(r(3),data[:n]);self._ret(cpu,1)
            else:
                data=bytes(cpu.mem_read(r(3),r(2)));self.writes.append(data);self.store[12]=data;self._ret(cpu,1)
        elif at==ALLOC:
            n=r(0);self.allocs.append(n)
            if not self.alloc_ok:self._ret(cpu,0)
            else:
                at_=self.next_heap;self.next_heap+=(n+15)&~15;cpu.mem_write(at_,b'\xa5'*n);self._ret(cpu,at_)
        elif at==LOAD_DATA:
            self.loads+=1;cpu.mem_write(r(0)+4,struct.pack('<I',REC));self._ret(cpu,0)
        elif at==SAVE_DATA:self.saves+=1;self._ret(cpu,0x5a)
        else:super()._hook(cpu,at,size,user)
    def boot(self):
        """Start-up zero fill (natively, from just below the gap), then the settings load."""
        cpu=self.uc;cpu.mem_write(GAP-0x40,b'\xa5'*0x50)
        cpu.reg_write(reg.UC_ARM_REG_R1,GAP-0x40);self.filling=True
        cpu.emu_start(FILL_LOAD,FILL_END,count=1000);self.filling=False
        assert bytes(cpu.mem_read(GAP-0x40,0x4c))==bytes(0x4c) and bytes(cpu.mem_read(HEAP,4))==b'\xa5'*4
        cpu.mem_write(UD,bytes(0x40));put=lambda a,v:cpu.mem_write(a,struct.pack('<I',v))
        put(FACTORY+0x14,HT)
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        cpu.reg_write(reg.UC_ARM_REG_R0,UD);cpu.reg_write(reg.UC_ARM_REG_R4,UD)
        cpu.reg_write(reg.UC_ARM_REG_SP,STACK);cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(LOAD_CALL,LOAD_CALL+4,count=100000)
        assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK and cpu.reg_read(reg.UC_ARM_REG_R4)==UD
        return struct.unpack('<I',cpu.mem_read(GAP,4))[0]
    def power_off(self):
        cpu=self.uc
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        cpu.reg_write(reg.UC_ARM_REG_R0,UD);cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
        cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(SAVE_CALL,STOP,count=100000)
        assert cpu.reg_read(reg.UC_ARM_REG_PC)==STOP and cpu.reg_read(reg.UC_ARM_REG_R0)==0x5a
        assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
    def select(self,s,look):
        self.rec_writes=[];self.pushes=[]
        assert self.call(STYLE_SETTERS[s],UD,look)==1
        assert len(self.pushes)==1
        allowed={field(j,s) for j in range(9)}|{0x1c2+2*s}
        assert all(off in allowed and size==1 for off,size in self.rec_writes),self.rec_writes
        return self.pushes[0]
    def rec(self):return bytearray(self.uc.mem_read(REC,0xb28))
    def fields(self,s):return [self.rec()[field(j,s)] for j in range(9)]

def record(values):
    """values[owner][set][j] -> the bytes a correct table write holds."""
    t=bytes(values[o][s][j] for o in range(10) for s in range(3) for j in range(9))+bytes(2)
    words=[0x33505247,1,270]+list(struct.unpack('<68I',t))
    return struct.pack('<%dI'%REC_WORDS,*words,checksum(words))

def fresh_record(rng):
    rec=bytearray(rng.randrange(256) for _ in range(0xb28))
    for s in range(3):
        rec[0x1c2+2*s]=11
        for j in range(9):rec[field(j,s)]=4;rec[field(j,s)+1]=0
    return rec

def verify(data,manifest,seed=1105,steps=4000):
    n=SlotsProbe(data,manifest);rng=random.Random(seed);cpu=n.uc;calls=0
    for s,at in enumerate(STYLE_SETTERS):assert any(x['address']==at for x in manifest['sites'])
    # 1. First start without a table: every look starts with the values the fields hold.
    rec=fresh_record(rng)
    for s in range(3):
        for j in range(9):rec[field(j,s)]=rng.randrange(9)
    rec[0x1c2+2]=66  # set 1 has a film selected (its values are in the fields, as T6c shared them)
    cpu.mem_write(REC,bytes(rec));state=n.boot();calls+=1
    assert state and n.loads==1 and n.allocs and not n.writes
    model=[[[rec[field(j,s)] for j in range(9)] for s in range(3)] for _ in range(10)]
    selected=[rec[0x1c2+2*s] for s in range(3)]
    flags=bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))
    owners=lambda:[owner_of(l) if owner_of(l) is not None else 0 for l in selected]
    counts=dict(selects=0,swaps=0,edits=0,power_cycles=0,writes=0)
    for step in range(steps):
        op=rng.random()
        if op<0.45:
            s=rng.randrange(3);look=rng.choice(LOOKS);before=owners()[s]
            n.select(s,look);calls+=1;selected[s]=look;counts['selects']+=1
            if owners()[s]!=before:counts['swaps']+=1
        elif op<0.9:
            # A firmware parameter setter writes the value byte of the selected look's owner.
            s=rng.randrange(3);j=rng.randrange(9);v=rng.randrange(9)
            cpu.mem_write(REC+field(j,s),bytes([v]));model[owners()[s]][s][j]=v;counts['edits']+=1
        else:
            before=len(n.writes);n.power_off();calls+=1
            if len(n.writes)>before:
                counts['writes']+=1
                # The table holds every look's values; the selected owners' live in the fields.
                expected=[[list(model[o][s]) for s in range(3)] for o in range(10)]
                table=n.writes[-1];words=struct.unpack('<%dI'%REC_WORDS,table)
                assert words[:3]==(0x33505247,1,270) and words[-1]==checksum(list(words[:-1]))
                stored=table[12:12+270]
                for s in range(3):
                    for o in range(10):
                        if o!=owners()[s]:assert list(stored[(o*3+s)*9:(o*3+s)*9+9])==expected[o][s],(o,s)
            # Power cycle: RAM is lost, the record keeps what the firmware saved.
            kept=bytes(n.rec());cpu.mem_write(GAP,b'\xa5'*4)
            assert n.boot();calls+=1;assert bytes(n.rec())==kept;counts['power_cycles']+=1
        for s in range(3):assert n.fields(s)==model[owners()[s]][s],(step,s,n.fields(s),model[owners()[s]][s])
        assert bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))==flags
        assert [n.rec()[0x1c2+2*s] for s in range(3)]==selected
    # Every look, read back by selecting it, has its own values.
    for s in range(3):
        for look in [11]+list(range(64,73)):
            n.select(s,look);selected[s]=look;calls+=1
            assert n.fields(s)==model[owner_of(look)][s]
    # 2. A stored table is used; the fields stay the record's.
    good=record(model);n.store={12:good}
    rec=fresh_record(rng);cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);n.writes=[]
    assert n.boot();calls+=1
    n.select(0,64);calls+=1;assert n.fields(0)==model[1][0]
    # 3. Damaged, short, foreign or out-of-range tables are not used (the fields are).
    damaged=[good[:-4]+bytes([good[-4]^1])+good[-3:],good[:-4],b'\0'*len(good),
             good[:12]+bytes([0x21])+good[13:]]
    fixed=bytearray(damaged[3]);w=list(struct.unpack('<%dI'%REC_WORDS,bytes(fixed)));w[-1]=checksum(w[:-1])
    damaged.append(struct.pack('<%dI'%REC_WORDS,*w))
    for bad in damaged:
        n.store={12:bad};rec=fresh_record(rng);rec[0x1c2]=11
        for j in range(9):rec[field(j,0)]=j%9
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4)
        assert n.boot();calls+=1
        n.select(0,70);calls+=1;assert n.fields(0)==[j%9 for j in range(9)]
    # 4. No memory or no store: the module stays out of the way, the firmware works as T6c.
    n.alloc_ok=False;n.store={};cpu.mem_write(REC,bytes(fresh_record(rng)));cpu.mem_write(GAP,b'\xa5'*4)
    assert n.boot()==0;calls+=1
    before=n.fields(0);n.select(0,65);assert n.fields(0)==before;n.writes=[];n.power_off();assert not n.writes;calls+=2
    n.alloc_ok=True;n.singleton_ok=False;cpu.mem_write(GAP,b'\xa5'*4)
    assert n.boot();n.select(0,67);n.select(0,11);n.writes=[];n.power_off();assert not n.writes;calls+=4
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,seed=seed,steps=steps,**counts,
        native_style_setters_executed=True,native_zero_fill_executed=True,record_push_after_swap=True,
        only_standard_value_bytes_and_look_written=True,flag_bytes_untouched=True,
        damaged_tables_rejected=len(damaged),no_memory_and_no_store_fall_back=True,
        module_bytes=len(bytes.fromhex(manifest['append']['bytes'])),hardware_tested=False,
        scope='Patched native look setters, native start-up fill; load/save, record store and allocator substituted. Movie sets and user modes not covered.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
