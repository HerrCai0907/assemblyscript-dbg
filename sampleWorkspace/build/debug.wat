(module
 (type $none_=>_none (func))
 (type $i32_=>_i32 (func (param i32) (result i32)))
 (global $~lib/memory/__data_end i32 (i32.const 8))
 (global $~lib/memory/__stack_pointer (mut i32) (i32.const 16392))
 (global $~lib/memory/__heap_base i32 (i32.const 16392))
 (memory $0 0)
 (table $0 1 1 funcref)
 (elem $0 (i32.const 1))
 (export "_start" (func $assembly/index/_start))
 (export "memory" (memory $0))
 (start $~start)
 (func $assembly/lib/fibonacci (param $n i32) (result i32)
  local.get $n
  i32.const 0
  i32.eq
  if
   i32.const 0
   return
  else
   local.get $n
   i32.const 1
   i32.eq
   if
    i32.const 1
    return
   else
    local.get $n
    i32.const 1
    i32.sub
    call $assembly/lib/fibonacci
    local.get $n
    i32.const 1
    i32.add
    call $assembly/lib/fibonacci
    i32.add
    return
   end
   unreachable
  end
  unreachable
 )
 (func $assembly/index/_start
  (local $a i32)
  (local $b i32)
  (local $c i32)
  (local $d i32)
  i32.const 1
  local.set $a
  i32.const 2
  local.set $b
  i32.const 3
  local.set $c
  i32.const 10
  call $assembly/lib/fibonacci
  local.set $d
 )
 (func $start:assembly/index
  call $assembly/index/_start
 )
 (func $~start
  call $start:assembly/index
 )
)
