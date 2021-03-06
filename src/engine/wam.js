"use strict";

/* For general documentation, see wam_compiler.pl

Some helpful diagrams:
Environment frame looks like this:
              -----------
    state.E ->|0  | CE  |
              |1  | CP  |
              |2  | Y0  |
              |...|     |
              |n+1| Yn  |
              -----------

Choicepoint frame where we have tried something but can try 'Next' if it fails looks like this:
(There are n arguments, labelled from A0 to An-1)

              -------------
    state.B ->|0  | n     |
              |1  | A0    |
              |2  | A1    |
              |...|       |
              |n  | An-1  |
              |n+1| E     |
              |n+2| CP    |
              |n+3| B     |
              |n+4| Next  |
              |n+5| TR    |
              |n+6| H     |
              |n+7| B0    |
              |n+8| TC    |
              |n+9| TI    |
              -------------

*/

//const E_CE = 0;
const E_CP = 1;
// const E_Y0 = 2;
// const E_Y1 = 3;
// const E_Y2 = 4;

//const CP_n = 0;
const CP_E = 1;
const CP_CP = 2;
const CP_B = 3;
const CP_Next = 4;
const CP_TR = 5;
const CP_H = 6;
const CP_B0 = 7;
const CP_TC = 8;
const CP_TI = 9;
const CP_SIZE = 10;

const FCP_V = 1; // foreign choicepoint 'value'
const FCP_C = 2; // foreign choicepoint 'code'
const FCP_R = 3; // foreign choicepoint registers (0 to n-1) start at this offset from state.B.


let ftable = [];
let dtable = [];
let atable = ['[]']; // Reserve first atom as [].
let floats = [];
let predicates = {};
let indexed_predicates = [];
let exception = null;
let itable = [];
let stable = [];
let maxStackSize = 0;
let maxHeapSize = 0;

/* Constants. Should be auto-generated */
const HEAP_SIZE = 1410700;
const STACK_SIZE = 65535;
const TRAIL_SIZE = 1000;
const READ = 0;
const WRITE = 1;
const TAG_REF = 0; // 0x00000000
const TAG_STR = 1; // 0x08000000
const TAG_LST = 2; // 0x10000000
const TAG_INT = 3; // 0x18000000
const TAG_ATM = 4; // 0x20000000
const TAG_FLT = 5; // 0x28000000
///////////// 6 is currently unused
//const TAG_EXT = 7; // Reserved!
const TAG_MASK = 7;
// 3 bits are used for the tag
// 2 bits are used for GC
// This leaves 27 for the actual value, since javascript does not have 64-bit integers
const WORD_BITS = 27;
const M_BIT = 1 << 30;
const F_BIT = 1 << 31;
const NV_MASK = M_BIT | F_BIT | (TAG_MASK << WORD_BITS);

const NIL = (TAG_ATM << WORD_BITS); // atable[0] = '[]', so NIL is 0 xor TAG_ATM, which is just TAG_ATM.
const FAIL_ADDRESS = 1000000; // used in switch_on_term to recognize an address that 'fails'.

let memory = new Array(HEAP_SIZE + STACK_SIZE + TRAIL_SIZE);
let code = [255];
let register = new Array(256);
let state;

// Stack for managing cleanup handlers needed during a cut
let cleanups = [];

let bootstrap_code; // 'defined' by load_state() in proscriptls_state.js.
let retry_foreign_offset;  // 'defined' by load_state() in proscriptls_state.js.
let foreign_predicates; // 'defined' by load_state() in proscriptls_state.js.
let system;  // 'defined' by load_state() in proscriptls_state.js.
let initialization;  // 'defined' by load_state() in proscriptls_state.js.
let module_exports;  // 'defined' by load_state() in proscriptls_state.js.
let module_imports;  // 'defined' by load_state() in proscriptls_state.js.
let meta_predicate_signatures;  // 'defined' by load_state() in proscriptls_state.js.

/* Special purpose machine registers:

   P: Pointer to the next opcode to execute (in the code[] array)
  CP: Continuation Pointer. Points to the next code to execute if the current environment succeeds (basically the return address when calling a function)
mode: READ or WRITE depending on whether are matching or creating an exemplar on the heap
   H: Pointer to the next available heap cell
  HB: Pointer to where the heap should be truncated to if we backtrack
  TR: Pointer to the next available trail cell
   S: Pointer to the next symbol on the heap to match when unifying
   E: Pointer to the top environment frame   
   B: Pointer to the top choicepoint
  B0: Pointer to the choicepoint to return to after backtracking over a cut (ie the choicepoint created by the most recent call opcode)


  It is important to note that B and E do not point to the *next available* place to put an environment frame or choicepoint, but the *current* one.
*/
let debugging = false;

// debug_msg function may not be called due to js_preprocess.js removing references to it.
// noinspection JSUnusedLocalSymbols
function debug_msg(msg)
{
    if (debugging)
        debug(msg);
}

function initialize()
{
    let trace_ftor = VAL(lookup_functor('debugger:$traceR', 3));
    let trace_predicate = predicates[trace_ftor];
    let key = (trace_predicate.index) ? trace_predicate.index : trace_predicate.clause_keys[0];
    let trace_code = trace_predicate.clauses[key].code;

    state = {H: 0,
             HB: 0,
             S: 0,
             P: 2,             
             CP: {code: bootstrap_code, 
                  predicate: null,
                  offset:1}, // halt
             B0: 0, // No backtrack frame
             B: 0,  // No backtrack frame
             E: HEAP_SIZE,
             TR: HEAP_SIZE + STACK_SIZE,
             mode: READ,
             running: false,
             foreign_retry: false,
             num_of_args: 0,
             current_predicate: null,
             trace_info: NIL,
             trace_call: 'no_trace',
             trace_identifier: 0,
             trace_predicate: trace_predicate,
             trace_code: trace_code,
             trace_prompt: '>',
             suspended: false,
             wamYielded: false};
    code = bootstrap_code;
    cleanups = [];
}

function abort(why)
{        
    debug(why);
    throw why;
}

function bind(a, b)
{
    if (TAG(a) === TAG_REF && (TAG(b) !== TAG_REF || VAL(b) < VAL(a)))
    {
        memory[VAL(a)] = b;
        trail(a);
    }
    else
    {
        memory[VAL(b)] = a;
        trail(b);
    }
}

function tidy_trail()
{
    let t = memory[state.B + memory[state.B] + CP_TR];
    if (t < HEAP_SIZE + STACK_SIZE)
        abort("Backtrack pointer " + state.B + " has garbage for TR: " + hex(t));
    while (t < state.TR)
    {
        if ((memory[t] < state.HB) || (state.H < memory[t] && memory[t] < state.B))
        {
            // This trailing is still required
            t = t + 1;
        }
        else
        {
            memory[t] = memory[state.TR - 1];
            state.TR = state.TR - 1;
        }
    }   
}

function trail(v)
{
    if (v < state.HB || (state.H < v && v < state.B))
    {
        debug_msg("Trailing " + v);
        memory[state.TR++] = v;
    }
    else
    {
        debug_msg("NOT Trailing " + v + " because neither v < " + state.HB + " nor " + state.H + " < v < " + state.B);
    }
}

function unwind_trail(from, to)
{
    debug_msg("unwinding trail from " + from + " to " + to);
    for (let i = from; i < to; i++)
    {
        memory[memory[i]] = memory[i] ^ (TAG_REF << WORD_BITS);
    }
}

// Returns boolean
function unify(a, b)
{
    let PDL = [];

    PDL.push(a);
    PDL.push(b);
    let failed = false;
    while (PDL.length !== 0 && !failed)
    {
        let d1 = deref(PDL.pop());
        let d2 = deref(PDL.pop());
        // if d1 == d2 then just proceed with the rest of the PDL. Otherwise we need to try and unify them, or fail
        if (d1 !== d2)
        {
            let type1 = TAG(d1);
            let val1 = VAL(d1);
            let type2 = TAG(d2);
            let val2 = VAL(d2);
            if (type1 === TAG_REF)
            {
                bind(d1, d2);
            }
            else
            {
                switch(type2)
                {
                case TAG_REF:
                    bind(d1, d2);
                    break;
                case TAG_ATM:
                case TAG_INT:
                    failed = true;
                    break;
                case TAG_FLT:
                    if (type1 === TAG_FLT)
                    {
                        debug(floats[val1] + " vs " + floats[val2]);
                    }
                    failed = true;
                    break;
                case TAG_LST:
                    if (type1 === TAG_LST)
                    {                        
                        PDL.push(memory[val1]); // unify heads
                        PDL.push(memory[val2]);
                        PDL.push(memory[val1+1]); // unify tails
                        PDL.push(memory[val2+1]);
                    }
                    else
                        failed = true; // list and non-list
                    break;
                case TAG_STR:
                    if (type1 === TAG_STR)
                    {
                        let f1 = VAL(memory[val1]);
                        let f2 = VAL(memory[val2]);
                        if (f1 === f2)
                        {
                            for (let i = 0; i < ftable[f1][1]; i++)
                            {
                                PDL.push(val1 + 1 + i);
                                PDL.push(val2 + 1 + i);
                            }
                        }
                        else
                            failed = true; // different functors
                    }
                    else
                        failed = true; // str and atom/list
                }
            }
        }
    }
    return !failed;
}

function deref(p)
{
    while(TAG(p) === TAG_REF && VAL(p) !== memory[VAL(p)])
    {
        let q = memory[VAL(p)];
        if (q === undefined) // FIXME: Check that q =< p?
        {
            debug_msg("Illegal memory access in deref: " + hex(p) + ". Dumping...");
            abort("Bad memory access: @" + p);
        }
        else
            p = q;
    }
    return p;
}

// This should be a macro
/**
 * @return {number}
 */
function TAG(p)
{
    // >>> is unsigned-right-shift. Nice.
    return (p >>> WORD_BITS) & TAG_MASK;
}

// This should be a macro
/**
 * @return {number}
 */
function VAL(p)
{
    return p & ((1 << WORD_BITS)-1);
}

function ftable_arity(ftor) {
    if(ftable[ftor] === undefined) {
        throw('no ftable entry at ' + ftor);
    }
    return ftable[ftor][1];
}

// Ideally this would be inlined, but javascript does not support macros. Ultimately this could be generated dynamically.
function backtrack()
{    
    debug_msg("Backtracking. State.B is " + state.B);
    if (state.B <= HEAP_SIZE)
    {
        return false;
    }
    debug_msg("Choicepoint has " + memory[state.B] + " saved args");
    state.B0 = memory[state.B + memory[state.B] + CP_B0];
    // Also unwind any trailed bindings
    unwind_trail(memory[state.B + memory[state.B] + CP_TR], state.TR);
    let next = memory[state.B + memory[state.B] + CP_Next];
    state.P = next.offset;
    code = next.code;
    if(! code) {
        throw 'code is undefined';
    }

    state.current_predicate = next.predicate;
    if(state.current_predicate) {
        state.num_of_args = ftable[state.current_predicate.key][1];
    }

    if(state.trace_call !== 'no_trace') {
        let traceCallPL = memory[state.B + memory[state.B] + CP_TC];
        state.trace_call = atable[VAL(traceCallPL)];
        if(! state.trace_call) {
            throw 'backtrack trace_call is undefined';
        }
        state.trace_info = memory[state.B + memory[state.B] + CP_TI];
    }
    debug_msg("Set state.trace_call to " + state.trace_call);
    debug_msg("Set state.P to " + state.P);
    return true;
}

function predicate_get_backtrack_frame(B) {
    let term = PL_put_integer(state.B);
    //stdout('Backtrack frame = ' + VAL(term) + '\n');
    return unify(B, term);
}

function predicate_set_backtrack_frame(B) {
    //let type = TAG(B);
    state.B = VAL(B);
    //stdout('Backtrack frame set to ' + state.B + '\n');
    return true;
}

// Returns a <STR, f/n> cell. This MUST be followed (eventually) by n args. Attempting to print the term (or otherwise use) the term before then will result in chaos
// ftor must have the ATM tag!
function alloc_structure(ftor)
{
    let tmp = state.H;
    memory[state.H++] = ftor;
    if(state.H > maxHeapSize) {
        maxHeapSize = state.H;
    }
    return tmp ^ (TAG_STR << WORD_BITS);
}

function alloc_var()
{
    let result = state.H ^ (TAG_REF << WORD_BITS);
    memory[state.H] = result;    
    state.H++;
    if(state.H > maxHeapSize) {
        maxHeapSize = state.H;
    }
    return result;
}

function alloc_list()
{
    let result = (state.H+1) ^ (TAG_LST << WORD_BITS);
    memory[state.H] = result;    
    state.H++;
    if(state.H > maxHeapSize) {
        maxHeapSize = state.H;
    }
    return result;
}

function wam_setup_trace_call(target_ftor_ofst) {
    // Create a 'traceArgStructure' for 'X(A0, ..., An-1)', copying
    // args A0 through An from register[0] to register[n-1]
    // where n = arity of predicate.

    let traceArgArity = ftable[target_ftor_ofst][1];
    if(traceArgArity === 0) {
        register[0] = (ftable[target_ftor_ofst][0]) ^ (TAG_ATM << WORD_BITS);
    } else {
        let target_ftor = target_ftor_ofst ^ (TAG_ATM << WORD_BITS);
        let traceArgStructure = alloc_structure(target_ftor);
        let argOfst = 0;
        for (; argOfst < traceArgArity; argOfst++) {
            memory[state.H++] = register[argOfst];
        }
        if(state.H > maxHeapSize) {
            maxHeapSize = state.H;
        }

        // Make the traceArgStructure the first argument.
        // The info term is the second argument. It is set
        // by '$trace' before evaluating call/.

        register[0] = traceArgStructure;
    }
    register[1] = state.trace_info;
    register[2] = PL_put_integer(state.trace_identifier);
    return traceArgArity;
}

let call_log = [];
function add_to_call_log(msg) {
   let currentPredicateString = (state.current_predicate == null)
       ?("no predicate")
       :(atable[ftable[state.current_predicate.key][0]] + "/" + ftable[state.current_predicate.key][1]);

    if(call_log.length > 100) {
        call_log = call_log.slice(1);
    }
    call_log.push(currentPredicateString + ": " + msg);
}

function wam_complete_call_or_execute(predicate) {
   if (predicate.clauses && predicate.clause_keys && predicate.clause_keys.length > 0
           && predicate.clauses[predicate.clause_keys[0]]) {
        //stdout("Complete " + atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1] + '\n');
//        add_to_call_log(atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1]);
        state.B0 = state.B;
        state.num_of_args = ftable[code[state.P + 1]][1];
        state.current_predicate = predicate;
        let key = (predicate.index) ? predicate.index : predicate.clause_keys[0];
        code = predicate.clauses[key].code;
       if(! code) {
           throw 'code is undefined';
       }

       state.P = 0;
       return true;
    } else {
        return false;
    }
}

function wam_setup_and_call_foreign() {
//    add_to_call_log(atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1]);

    state.num_of_args = ftable[code[state.P+1]][1];
    let args = new Array(state.num_of_args);
    for (let i = 0; i < state.num_of_args; i++)
        args[i] = deref(register[i]);
    let result = foreign_predicates[code[state.P+1]].apply(null, args);
    state.foreign_retry = false;
    return result;
}


function wam_create_choicepoint(nextCP, prefix) {
    // 'n' (memory[newB]) is the number of slots of the dynamic initial portion of the choicepoint frame.
    // The choicepoint frame starting at memory[newB + n] is a fixed size, CP_SIZE, where
    // each slot i at memory[newB + n + i] has a fixed interpretation and a constant name
    // of the form CP_*. E.g. CP_TR is the 'trail' slot at memory[newB + n + CP_TR].
    //
    // The dynamic portion of the choicepoint frame for foreign calls
    // starts with a 'value' slot (at FCP_V == 1) and a 'code' slot (at FCP_C == 2).
    // This is followed (at FCP_R == 3) by a slot for each 'register' to be saved (generally
    // one register per predicate argument), as indicated by state.num_of_args.
    // The choicepoint frame for 'standard' (non-foreign) calls does not
    // have the initial two slots: the saved registers start at slot CP_R = 1.

    let newB;
    if (state.E > state.B) {
        // In this case, it is an environment. In the real WAM, which does stack trimming (see Ait-Kaci chapter 5.7), we only have CE, CP and then N saved Y-registers.
        // Therefore, we need to write the new choicepoint at 2 + N. What is N, though? Well, it turns out N gets gradually smaller as time goes on, which
        // is why it is not stored in the frame itself. If call(f) is outfitted with a second argument to become call(f, n) then we can decode this in try_me_else
        // (and ignore it if we did not want to create a new environment) by looking at CP, which points to the instruction after the call() opcode. Therefore,
        // code[CP-1] ought to be N.

        // -----------
        // |0  | CE  |
        // |1  | CP  |
        // |3  | Y0  |
        //  ...
        // |n+2| Yn  |
        // -----------
        debug_msg("P=" + state.P + " Top frame is an environment. Starts at " + state.E + " and has length = " + state.CP.code[state.CP.offset - 1] + " + 2. Previous is " + memory[state.E]);
        debug_msg("Top choicepoint is " + state.B);
        newB = state.E + state.CP.code[state.CP.offset - 1] + 2; // this is corrected according to Ait-Kaci wamerratum.txt.
    } else {
        // In this case, the top frame is a choicepoint. This is a bit easier: A choicepoint contains 7 saved special-purpose registers, the N root arguments
        // for the goal, and, happily, the value of N as the very first argument. Therefore, we can read the 0th entry of the current frame (at state.B)
        // and add CP_SIZE (=10) to it to get the top of the stack.
        debug_msg("Top frame is a choicepoint: " + state.B);
        debug_msg("Top environment is " + state.E);
        newB = state.B + memory[state.B] + CP_SIZE;
    }

    memory[newB] = state.num_of_args + prefix.length;
    let n = memory[newB];
    for (let prefixOfst = 0; prefixOfst < prefix.length; prefixOfst++) {
        memory[newB + prefixOfst + 1] = prefix[prefixOfst];
    }
    let prefixAdjust = prefix.length + 1;

    debug_msg("Saving " + n + " args" + (prefix && prefix.length > 0) ? (" with " + prefix.length + " specials") : "");
    for (let i = 0; i < state.num_of_args; i++) {
        debug_msg("Saving register " + i + "(" + hex(register[i]) + ") to " + (newB + FCP_R + i));
        memory[newB + prefixAdjust + i] = register[i];
    }
    // Save the current context
    memory[newB + n + CP_E] = state.E;
    memory[newB + n + CP_CP] = state.CP;
    memory[newB + n + CP_B] = state.B;
    memory[newB + n + CP_Next] = nextCP;
    memory[newB + n + CP_TR] = state.TR;
    memory[newB + n + CP_H] = state.H;
    memory[newB + n + CP_B0] = state.B0;
    memory[newB + n + CP_TC] = lookup_atom(state.trace_call);
    memory[newB + n + CP_TI] = state.trace_info;
    state.B = newB;
    state.HB = state.H;

    let stackTop = newB + n + CP_SIZE - 1;

    if(maxStackSize < stackTop) {
        maxStackSize = stackTop;
    }
}

function wam_trace_call_or_execute(functor) {
    return ! functor.startsWith('debugger:') && ! functor.startsWith('system:$trace') &&
        ! state.foreign_retry &&
        functor !== 'true' && functor !== 'system:true' && state.trace_predicate &&
        (state.trace_call === 'trace' || state.trace_call === 'leap_trace');
}

function wam_suspend_trace() {
    if(state.trace_call === 'trace') {
        state.trace_call = 'skip_trace';
    } else if (state.trace_call === 'leap_trace') {
        state.trace_call = 'suspend_leap_trace';
    } else {
        abort("The state.trace_call register has an invalid value: '"
            + state.trace_call + "'. It must be either 'trace' or 'leap_trace'");
    }

    // ensure instruction tracing is disabled.
    state.trace_instruction = 'no_trace';
    state.trace_instruction_prompt = undefined;
    instruction_suspend_set('false');

}

function wam_advance_next_trace_conditionally() {
    // 'trace_next' and 'leap_trace_next' only occur when call/1 is invoked by '$trace'.
    if (state.trace_call === 'trace_next') {
        state.trace_call = 'trace';
        debug_msg("Set state.trace_call from 'trace_next' to " + state.trace_call);
    } else if (state.trace_call === 'leap_trace_next') {
        state.trace_call = 'leap_trace';
        debug_msg("Set state.trace_call from 'leap_trace_next' to " + state.trace_call);
    }
}

let wamDuration = 0;
let activeWamStartTime = undefined;
let wamNestedInvocations = 0;

function wamEntrance() {
    wamNestedInvocations++;
    if(wamNestedInvocations === 1) {
        activeWamStartTime = Date.now();
        //stdout('start: ' + activeWamStartTime + '\n');
    } else {
        //stdout('start nested: ' + wamNestedInvocations+ '\n');
    }
}

function wamExit(result) {
    wamNestedInvocations--;
    if(wamNestedInvocations === 0) {
        let wamTimeExit = Date.now();
        let duration = Math.max(wamTimeExit - activeWamStartTime, 0.1);
        wamDuration += duration;
        activeWamStartTime = undefined;
        //stdout('exit: ' + wamTimeExit + ', duration: ' + duration + '\n');
    } else {
        //stdout('exit nested: ' + wamNestedInvocations + '\n');
    }
    return result;
}

let reportedLargeStack = false;

function wamValidStackAddr(description, tmpE, instruction) {
    if (tmpE < HEAP_SIZE ) {
        abort("The " + description + " " + tmpE + " is less than minimum stack address (HEAP_SIZE=" + HEAP_SIZE + ") in " + instruction + " instruction.");
    } else if (tmpE > HEAP_SIZE + STACK_SIZE) {
        abort("The " + description + " " + tmpE + " is greater than maximum stack address (HEAP_SIZE+STACK_SIZE="+HEAP_SIZE+"+"+STACK_SIZE+"="+(HEAP_SIZE+STACK_SIZE) + ") in " + instruction + " instruction.");
    } else if (! reportedLargeStack && tmpE > HEAP_SIZE + 0.75 * STACK_SIZE ) {
        dumpWrite('Large stack (' + description + '): ' + tmpE);
        dump_environments();
        dump_choicepoints();
        reportedLargeStack = true;
    } else if (reportedLargeStack && tmpE <  HEAP_SIZE + 0.70 * STACK_SIZE ) {
        reportedLargeStack = false;
    }
}

function wamValidStackVarAddr(description, varID, tmpE, instruction) {
    if (tmpE < HEAP_SIZE ) {
        dump_environments();
        abort("The " + description + " " + varID + ' ' + tmpE + " is less than minimum stack address (HEAP_SIZE=" + HEAP_SIZE + ") in " + instruction + " instruction.");
    } else if (tmpE > HEAP_SIZE + STACK_SIZE) {
        dump_environments();
        dump_choicepoints();
        abort("The " + description + " " + varID + ' ' + tmpE + " is greater than maximum stack address (HEAP_SIZE+STACK_SIZE="+HEAP_SIZE+"+"+STACK_SIZE+"="+(HEAP_SIZE+STACK_SIZE) + ") in " + instruction + " instruction.");
    } else if (! reportedLargeStack && tmpE > HEAP_SIZE + 0.75 * STACK_SIZE ) {
        dumpWrite('Large stack (' + description + ' ' + varID + '): ' + tmpE);
        dump_environments();
        dump_choicepoints();
        reportedLargeStack = true;
    } else if (reportedLargeStack && tmpE <  HEAP_SIZE + 0.70 * STACK_SIZE ) {
        reportedLargeStack = false;
    }
}

function wamValidHeapOrStackAddr(description, tmpE, instruction) {
    if (tmpE < 0 ) {
        abort("The " + description + " " + tmpE + " is less than minimum heap+stack address (0) in " + instruction + " instruction.");
    } else if (tmpE > HEAP_SIZE + STACK_SIZE) {
        abort("The " + description + " " + tmpE + " is greater than maximum heap+stack address (HEAP_SIZE+STACK_SIZE="+HEAP_SIZE+"+"+STACK_SIZE+"="+(HEAP_SIZE+STACK_SIZE) + ") in " + instruction + " instruction.");
    } else if (! reportedLargeStack && tmpE > HEAP_SIZE + 0.75 * STACK_SIZE ) {
        dumpWrite('Large stack (' + description + '): ' + tmpE);
        dump_environments();
        dump_choicepoints();
        reportedLargeStack = true;
    } else if (reportedLargeStack && tmpE <  HEAP_SIZE + 0.70 * STACK_SIZE ) {
        reportedLargeStack = false;
    }
}

function wamValidHeapAddr(description, addr, instruction) {
    if (addr < 0 ) {
        abort("The " + description + " " + addr + " is less than minimum heap address (0) in " + instruction + " instruction.");
    } else if (addr >= HEAP_SIZE) {
        abort("The " + description + " " + addr + " is equal to or greater than maximum heap address (HEAP_SIZE="+HEAP_SIZE + ") in " + instruction + " instruction.");
    }
}

function wam() {
    try {
        return wam1();
    } catch (e) {
        wamExit(e);
        // dump_environments();
        // dump_choicepoints();
        throw e;
    }
}

function wam1()
{
    let predicate;
    let source;
    let sym;
    let arg;
    let offset;
    let functor;

    wamEntrance();

    state.running = true;
    while (state.running)
    {
        debug_msg("---");        
        debug_msg("P=" + (((state.current_predicate == null)?("no predicate"):(atable[ftable[state.current_predicate.key][0]] + "/" + ftable[state.current_predicate.key][1])) + "@" + state.P + ": " + code[state.P]) + ", H=" + state.H + ", B=" + state.B + ", B0=" + state.B0 + ", E=" + state.E);

        // The conditional "prolog_flag_values.wam_log !== 'none'" avoids the call to log() in the common case.
        // This makes a noticeable difference in performance.

        if(prolog_flag_values.wam_log !== 'none')
            log(prolog_flag_values.wam_log, decode_instruction(state.current_predicate, state.P).string);

        if(state.trace_call === 'trace' && state.trace_instruction &&
            (state.trace_instruction === 'trace' || state.trace_instruction === 'step')) {
            let instruction = decode_instruction(state.current_predicate, state.P);
            if (state.trace_instruction === 'step') {
                // set up the prompt to be displayed before reading a command character into
                // input_buffer
                state.trace_instruction_prompt = instruction.string;
                let char = get_terminal_char();
                if (char) {
                    if (char === 'm') {
                        // show internal debug info for current instruction (if DEBUG===true in Makefile)
                        debugging = true;
                        // break at next instruction
                        state.trace_instruction = 'step';
                    } else if (char === 'x') {
                        // do not show internal debug info for current instruction
                        debugging = false;
                        // break at next instruction
                        state.trace_instruction = 'step';
                    } else if (char === 'y') {
                        // do not show internal debug info for current and subsequent instructions
                        debugging = false;
                        // do not break at next instruction
                        state.trace_instruction = 'trace';
                    } else if (char === 'z') {
                        // show internal debug info for current and subsequent instructions (if DEBUG===true in Makefile)
                        debugging = true;
                        // do not break at next instruction
                        state.trace_instruction = 'trace';
                    } else {
                        stdout('Invalid command ' + char + '. Command must be "m", "x", "y", or "z".\n');
                        instruction_suspend_set('true');
                        return wamExit(true);
                    }
                } else {
                    // No command character was available,
                    // return to the wam caller (jquery terminal) where the
                    // current prompt will be displayed (showing the current instruction)
                    // the user will enter a command character,
                    // the wam caller (jquery terminal) calls the wam again with the same
                    // wam state as was present earlier so that the re-called wam
                    // can continue the evaluation.
                    instruction_suspend_set('true');
                    return wamExit(true);
                }
            } else {
                stdout(instruction.string + '\n');
            }
        } else {
           debugging = false;
        }

        if(! code) {
            throw 'code is undefined';
        }
        // Decode an instruction
        switch(code[state.P]) {
            case 1: // allocate
            {
                let tmpE;
                if (state.E > state.B) {
                    debug_msg("P=" + state.P + " Top frame is an environment, at " + state.E + " with previous environment of " + memory[state.E] + " and CP of " + memory[state.E + E_CP]);
                    let nextEnvironmentOfst = state.CP.code[state.CP.offset - 1] + 2; // this is as corrected by Ait-Kaci in wamerratum.txt.
                    // if(nextEnvironmentOfst > 10000) {
                    //     dump_environments();
                    //     dump_choicepoints();
                    //     gcWrite('very large environment. size='+ nextEnvironmentOfst);
                    // }
                    tmpE = state.E + nextEnvironmentOfst;
                } else {
                    debug_msg("Top frame is a choicepoint, at " + state.B);
                    tmpE = state.B + memory[state.B] + CP_SIZE;
                }

                // if(tmpE > HEAP_SIZE + 60000) {
                //     dump_environments();
                //     dump_choicepoints();
                //     gcWrite('environment for large stack. new E='+tmpE);
                // }

                debug_msg("Environment size is: " + state.CP.code[state.CP.offset - 1]);
                if (tmpE === undefined || isNaN(tmpE))
                    abort("Top of frame is garbage: " + tmpE);

                wamValidStackAddr('CP of new environment frame', tmpE+1, 'allocate');

                debug_msg("Allocating an environment at " + tmpE + " Y0 is at " + (tmpE + 2) + " state.B is " + state.B);
                // Save old environment and continuation
                memory[tmpE] = state.E;
                memory[tmpE + 1] = state.CP;
                state.E = tmpE;
                state.P += 1;

                if(maxStackSize < tmpE+1) {
                    maxStackSize = tmpE+1;
                }

            }
                continue;

            case 2: // deallocate
                debug_msg("state.B is currently " + state.B);
                debug_msg("state.E is currently " + state.E);
                state.CP = memory[state.E + E_CP];
                debug_msg("state.CP set to " + state.CP + " from memory[" + (state.E + E_CP) + "]");
                wamValidStackAddr('previous base of environment frame', memory[state.E], 'deallocate');

                state.E = memory[state.E];
                debug_msg("Deallocate: E is reduced to " + state.E);
                state.P += 1;
                continue;

            case 3: // call

                functor = atable[ftable[code[state.P + 1]][0]];

                if (wam_trace_call_or_execute(functor)) {
                    // Trace this call of X(...).
                    // Suspend tracing to prevent the trace mechanism from tracing itself.
                    state.CP = {
                        code: code,
                        predicate: state.current_predicate,
                        offset: state.P + 3
                    };
                    state.B0 = state.B;

                    wam_suspend_trace();

                    debug_msg("Set state.trace_call to " + state.trace_call);

                    state.trace_identifier++;

                    let target_ftor_ofst = code[state.P + 1];
                    wam_setup_trace_call(target_ftor_ofst);

                    debug_msg("Calling trace " + atable[ftable[target_ftor_ofst][0]] + "/" + ftable[target_ftor_ofst][1] + " so setting CP to " + (state.P + 3) + ", argument is " + code[state.P + 2]);

                    state.num_of_args = 3;
                    state.current_predicate = state.trace_predicate;
                    code = state.trace_code;
                    state.P = 0;
                } else {
                    wam_advance_next_trace_conditionally();

                    predicate = predicates[code[state.P + 1]];
                    if (predicate !== undefined) {
                        // Set CP to the next instruction so that when the predicate is finished executing we know where to come back to
                        state.CP = {
                            code: code,
                            predicate: state.current_predicate,
                            offset: state.P + 3
                        };

                        //stdout("Calling " + atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1] + '\n');
                        debug_msg("Calling " + atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1] + " so setting CP to " + (state.P + 3) + ", argument is " + code[state.P + 2]);
                        let result =
                            wam_complete_call_or_execute(predicate);
                        if (!result && !backtrack()) {
                            return wamExit(false);
                        }
                    } else if (foreign_predicates[code[state.P + 1]] !== undefined) {
                        // This is a bit counter-intuitive since it seems like we are never going to get a proceed to use the CP.
                        // Remember that any time we might need CP to be saved, it will be. (If there is more than one goal, there will be an environment).
                        // If there is only one goal (ie a chain rule) then we will be in execute already, not call.
                        // This means it is never unsafe to set CP in a call port.
                        // Further, remember that state.CP is used to create choicepoints (and environments), and since foreign frames may create these, we must set CP to
                        // something sensible, even though we never expect to use it to actually continue execution from.
                        state.CP = {
                            code: code,
                            predicate: state.current_predicate,
                            offset: state.P + 3
                        };
                        //stdout("Calling (foreign) " + atable[ftable[code[state.P+1]][0]] + "/" + ftable[code[state.P+1]][1] + '\n');
                        debug_msg("Calling (foreign) " + atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1] + " and setting CP to " + (state.P + 3));
                        let result = wam_setup_and_call_foreign();
                        if (result)
                            state.P = state.P + 3;
                        else if (!backtrack()) {
                            return wamExit(false);
                        }
                    } else {
                        if (!undefined_predicate(code[state.P + 1]))
                            return wamExit(false);
                    }
                }
                continue;

            case 4: // execute
                functor = atable[ftable[code[state.P + 1]][0]];

                if (wam_trace_call_or_execute(functor)) {
                    wam_suspend_trace();

                    state.trace_identifier++;
                    debug_msg("Set state.trace_call to " + state.trace_call);
                    let target_ftor = code[state.P + 1];
                    wam_setup_trace_call(target_ftor);

                    debug_msg("Executing trace " + atable[ftable[target_ftor][0]] + "/" + ftable[target_ftor][1]);
                    state.B0 = state.B;
                    state.num_of_args = 3;
                    state.current_predicate = state.trace_predicate;
                    code = state.trace_code;
                    state.P = 0;
                } else {
                    wam_advance_next_trace_conditionally();

                    predicate = predicates[code[state.P + 1]];

                    if (predicate !== undefined) {
                        // No need to save continuation for execute

                        //stdout("Executing " + atable[ftable[code[state.P+1]][0]] + "/" + ftable[code[state.P+1]][1] + '\n');
                        debug_msg("Executing " + atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1]);
                        let result =
                            wam_complete_call_or_execute(predicate);
                        if (!result && !backtrack()) {
                            return wamExit(false);
                        }
                    } else if (foreign_predicates[code[state.P + 1]] !== undefined) {
                        //stdout("Executing (foreign) " + atable[ftable[code[state.P+1]][0]] + "/" + ftable[code[state.P+1]][1] + '\n');
                        debug_msg("Executing (foreign) " + atable[ftable[code[state.P + 1]][0]] + "/" + ftable[code[state.P + 1]][1]);
                        let result = wam_setup_and_call_foreign();
                        debug_msg("Foreign result: " + result + " and CP: " + state.CP);
                        if (result) {
                            state.current_predicate = state.CP.predicate;
                            code = state.CP.code;
                            if (!code) {
                                throw 'code is undefined';
                            }

                            state.P = state.CP.offset;
                        } else if (!backtrack())
                            return wamExit(false);
                    } else {
                        if (!undefined_predicate(code[state.P + 1]))
                            return wamExit(false);
                    }
                }
                continue;

            case 5: // proceed
                state.P = state.CP.offset;
                state.current_predicate = state.CP.predicate;
                if(state.current_predicate) {
                    state.num_of_args = ftable[state.current_predicate.key][1];
                }
                code = state.CP.code;
                if (!code) {
                    throw 'code is undefined';
                }

                continue;

            case 6: // put_variable: Initialize a new variable in Yn, and also put it into Ai
            {
                let varID = code[state.P + 1];
                let register_location6 = state.E + varID + 2;
                debug_msg("Putting new variable into Y" + varID + " at " + register_location6);
                wamValidStackAddr('environment variable ' + code[state.P + 1], register_location6, 'put_variable');
                memory[register_location6] = register_location6 ^ (TAG_REF << WORD_BITS);
                register[code[state.P + 2]] = register_location6 ^ (TAG_REF << WORD_BITS);
                state.P += 3;
                // noinspection UnnecessaryContinueJS
                continue;
            }

            case 7: // put_variable: Put fresh var into registers Ai and Xn
            {

                let freshvar = state.H ^ (TAG_REF << WORD_BITS);
                wamValidHeapAddr('heap top', state.H, 'put_variable');
                memory[state.H] = freshvar;
                register[code[state.P + 1]] = freshvar;
                register[code[state.P + 2]] = freshvar;
                state.H++;
                if(state.H > maxHeapSize) {
                    maxHeapSize = state.H;
                }
                debug_msg("After put_variable, state.H is now " + state.H);
                state.P += 3;
            }
            continue;

        case 8: // put_value
            if (code[state.P+1] === 0) // Y-register
            {
                let register_location8 = state.E + code[state.P+2] + 2;
                wamValidStackVarAddr('read stack var Y', code[state.P+2], register_location8, 'put_value');

                if (memory[register_location8] === undefined)
                    abort("Invalid memory access in put_value");
                register[code[state.P+3]] = memory[register_location8];
                debug_msg("put_value(Y" + code[state.P+2] + ", A" + code[state.P+3] + "): memory[" + register_location8 + "] = "  + hex(memory[register_location8]));
            }
            else
            {
                debug_msg("put_value: " + hex(register[code[state.P+2]]));
                register[code[state.P+3]] = register[code[state.P+2]];
            }
            state.P += 4;
            continue;

        case 9: // put_unsafe_value
        {
            let register_location9 = state.E + code[state.P + 1] + 2;
            // This is the unsafe bit. If the value now in register[code[state.P+2]] is on the stack (that is, it is > E) then we have to push a new variables
            // onto the stack to avoid dangling references to things that are about to be cleaned up
            wamValidStackVarAddr('read stack var Y', code[state.P+1], register_location9, 'put_unsafe_value');
            if (memory[register_location9] < state.E) {
                debug_msg("Value is safe");
                // No, so we can just behave like put_value
                register[code[state.P + 2]] = deref(memory[register_location9])
            } else {
                // Yes, so we need to push a new variable instead
                debug_msg("x0 memory[" + state.E + "] = " + memory[state.E]);
                debug_msg("Value is unsafe. Allocating a new unbound variable for it. It will go into Y" + code[state.P + 1] + " @ " + register_location9 + ". E = " + state.E);
                let v = alloc_var();
                debug_msg("x1 memory[" + state.E + "] = " + memory[state.E]);
                debug_msg("Binding " + hex(v) + " and Y" + code[state.P + 1] + " = " + hex(memory[register_location9]));
                bind(v, memory[register_location9]);
                debug_msg("x2 memory[" + state.E + "] = " + memory[state.E]);
                register[code[state.P + 2]] = v;
                debug_msg("x3 memory[" + state.E + "] = " + memory[state.E]);
                debug_msg("X" + code[state.P + 2] + " <- " + v);
            }
            state.P += 3;
            // noinspection UnnecessaryContinueJS
            continue;
        }
        case 10: // put_constant C into Ai            
            register[code[state.P+2]] = code[state.P+1] ^ (TAG_ATM << WORD_BITS);
            state.P += 3;
            continue;

        case 11: // put_nil into Ai
            register[code[state.P+1]] = NIL;
            state.P += 2;
            continue;

        case 12: // put_structure
            register[code[state.P+2]] = alloc_structure(code[state.P+1] ^ (TAG_ATM << WORD_BITS));
            state.mode = WRITE;
            state.P += 3;
            continue;

        case 13: // put_list
            register[code[state.P+1]] = alloc_list();
            state.mode = WRITE;
            state.P += 2;
            continue;

        case 14: // put_integer I into Ai
            register[code[state.P+2]] = (code[state.P+1] & ((1 << WORD_BITS)-1)) ^ (TAG_INT << WORD_BITS);
            state.P += 3;
            continue;           

        case 15: // get_variable
            if (code[state.P+1] === 0) // Y-register
            {
                let register_location15 = state.E + code[state.P+2] + 2;
                wamValidStackVarAddr('write stack var Y', code[state.P+2], register_location15, 'put_unsafe_value');
                debug_msg("Y" + code[state.P+2] + " <- " + hex(register[code[state.P+3]]));
                memory[register_location15] = register[code[state.P+3]];
            }
            else
            {
                debug_msg("X" + code[state.P+2] + " <- " + hex(register[code[state.P+3]]));
                register[code[state.P+2]] = register[code[state.P+3]];
            }
            state.P+= 4;
            continue;
            
        case 16: // get_value
        {
            let target = register[code[state.P + 3]];
            gc_check(target);
            if (code[state.P + 1] === 0) // Y-register
            {
                let register_location16 = state.E + code[state.P + 2] + 2;
                wamValidStackVarAddr('read stack var Y', code[state.P+2], register_location16, 'get_value');
                source = memory[register_location16];
            } else {
                source = register[code[state.P + 2]];
            }
            state.P += 4;
            debug_msg("get_value: Unifying " + hex(source) + " and " + hex(target));
            if (!unify(source, target))
                if (!backtrack())
                    return wamExit(false);
        }
            continue;

        case 17: // get_constant C from Ai            
            // First, get what is in Ai into sym
            sym = deref(register[code[state.P+2]]);
            // Then get arg. This is an atom index, not a <CON, i> cell. It needs to be made into the latter!
            arg = code[state.P+1] ^ (TAG_ATM << WORD_BITS);
            state.P += 3;
            if (TAG(sym) === TAG_REF)
            {
                // If Ai is variable, then we need to bind. This is when foo(bar) is called like foo(X).
                bind(sym, arg);
            }
            else if (sym !== arg)
            {
                debug_msg("Could not get constant: " + hex(sym) + " from " + hex(arg));
                if (!backtrack())
                    return wamExit(false);
            }
            continue;

        case 18: // get_nil
            sym = deref(register[code[state.P+1]]);
            state.P += 1;
            if (TAG(sym) === TAG_REF)
                bind(sym, NIL);
            else if (sym !== NIL)
                if (!backtrack())
                    return wamExit(false);
            continue;
            

        case 19: // get_structure
        {
            let structure_ftor = code[state.P + 1] ^ (TAG_ATM << WORD_BITS);
            let addr = deref(register[code[state.P + 2]]);
            state.P += 3;
            if (TAG(addr) === TAG_REF) {
                debug_msg("Arg passed is unbound. Proceeding in WRITE mode");
                state.mode = WRITE;
                let a = alloc_structure(structure_ftor);
                wamValidHeapOrStackAddr('bind addr', addr, 'get_list');
                bind(memory[addr], a);
            } else if (TAG(addr) === TAG_STR && memory[VAL(addr)] === structure_ftor) {
                debug_msg("Arg passed is bound to the right functor. Proceeding in READ mode from " + (VAL(addr) + 1));
                state.mode = READ;
                state.S = VAL(addr) + 1;
            } else {
                if (!backtrack())
                    return wamExit(false);
            }
        }
            continue;

        case 20: // get_list from Ai
        {
            let addr = deref(register[code[state.P + 1]]);
            state.P += 2;
            if (TAG(addr) === TAG_REF) {
                // predicate called with var and we are expecting a list
                let l = state.H ^ (TAG_LST << WORD_BITS);
                wamValidHeapOrStackAddr('bind addr', addr, 'get_list');
                bind(memory[addr], l);
                debug_msg("Bound memory[" + addr + "] ( " + memory[addr] + ") to (LST," + state.H + ")");
                state.mode = WRITE;
            } else if (TAG(addr) === TAG_LST) {
                debug_msg("get_list will proceed in read mode from " + VAL(addr));
                state.S = VAL(addr);
                state.mode = READ;
            } else if (!backtrack())
                return wamExit(false);
        }
            continue;

        case 21: // get_integer I from Ai            
            // First, get what is in Ai into sym
            sym = deref(register[code[state.P+2]]);
            // Then get arg. This is the actual integer, not a <INT, i> cell. It needs to be made into the latter!
            arg = (code[state.P+1] & ((1 << WORD_BITS)-1)) ^ (TAG_INT << WORD_BITS);
            state.P += 3;
            if (TAG(sym) === TAG_REF)
            {
                // If Ai is variable, then we need to bind. This is when foo(7) is called like foo(X).
                bind(sym, arg);
            }
            else if (sym !== arg)
            {
                debug_msg("Could not get constant: " + hex(sym) + " from " + hex(arg));
                if (!backtrack())
                    return wamExit(false);
            }
            continue;

        case 22: // unify_void
            if (state.mode === READ)
                state.S += code[state.P+1];
            else
                for (let i = 0; i < code[state.P+1]; i++)
                    alloc_var();
            state.P += 2;
            continue;

        case 23: //unify_variable
            if (state.mode === READ) // If reading, consume the next symbol
            {
                wamValidHeapOrStackAddr('read S', state.S, 'unify_variable');
                source = memory[state.S++];
                debug_msg("Unifying existing variable: " + hex(source) + " at " + (state.S-1));
                debug_msg(term_to_string(source));
            }
            else
            {
                source = alloc_var(); // If writing, create a new var
                debug_msg("Allocated new variable: " + source);
            }
            if (code[state.P+1] === 0) // Y-register
            {
                debug_msg("... for register Y" + code[state.P+2]);
                let register_location23 = state.E + code[state.P+2] + 2;
                // GC: This needs to be trailed if state.B is not 0, apparently
                wamValidStackVarAddr('stack environment var Y', code[state.P+2], register_location23, 'unify_variable');
                bind(memory[register_location23], source);
            }
            else
            {
                register[code[state.P+2]] = source;
            }
            state.P += 3;
            continue;

        case 24: // unify_value
        {
            let did_fail = false;
            if (state.mode === READ) {
                wamValidHeapOrStackAddr('read S', state.S, 'unify_value');
                source = memory[state.S++];
                if (code[state.P + 1] === 0) // Y-register
                {
                    let register_location24 = state.E + code[state.P + 2] + 2;
                    wamValidStackVarAddr('stack environment var Y', code[state.P+2], register_location24, 'unify_value');
                    did_fail = !unify(memory[register_location24], source);
                } else {
                    did_fail = !unify(register[code[state.P + 2]], source);
                }
            } else {
                if (code[state.P + 1] === 0) // Y-register
                {
                    let register_location24 = state.E + code[state.P + 2] + 2;
                    wamValidStackVarAddr('stack environment var Y', code[state.P+2], register_location24, 'unify_value');
                    wamValidHeapAddr('heap top', state.H, 'unify_value');
                    memory[state.H++] = memory[register_location24];
                } else {
                    wamValidHeapAddr('heap top', state.H, 'unify_value');
                    memory[state.H++] = register[code[state.P + 2]];
                }

                if(state.H > maxHeapSize) {
                    maxHeapSize = state.H;
                }
            }
            state.P += 3;
            if (did_fail)
                if (!backtrack())
                    return wamExit(false);
        }
            continue;
        case 25: // unify_local_value
        {
            let did_fail = false;
            if (state.mode === READ) {
                wamValidHeapOrStackAddr('read S', state.S, 'unify_local_value');
                source = memory[state.S++];
                if (code[state.P + 1] === 0) // Y-register
                {
                    let register_location25 = state.E + code[state.P + 2] + 2;
                    wamValidStackVarAddr('stack environment var Y', code[state.P+2], register_location25, 'unify_local_value');
                    did_fail = !unify(memory[register_location25], source);
                } else {
                    did_fail = !unify(register[code[state.P + 2]], source);
                }
            } else {
                let addr;
                if (code[state.P + 1] === 0) // Y-register;
                {
                    let register_location25 = state.E + code[state.P + 2] + 2;
                    wamValidStackVarAddr('stack environment var Y', code[state.P+2], register_location25, 'unify_local_value');
                    addr = memory[register_location25];
                } else {
                    addr = register[code[state.P + 2]];
                }
                addr = deref(addr);
                if (VAL(addr) < state.H) {
                    debug_msg("Unify local: already safe at " + hex(addr));
                    // Address is on the heap. Just push the value onto the top of the heap
                    debug_msg(term_to_string(addr));
                    wamValidHeapAddr('heap top', state.H, 'unify_local_value');
                    memory[state.H++] = addr;
                } else {
                    debug_msg("Unify local: unsafe. Globalizing");
                    // Address is on the stack. Push a new variable onto the heap and bind to the value
                    let fresh = state.H ^ (TAG_REF << WORD_BITS);
                    wamValidHeapAddr('heap top', state.H, 'unify_local_value');
                    memory[state.H++] = fresh;
                    debug_msg("Binding fresh variable " + fresh + " to " + addr);
                    bind(fresh, addr);
                    if (code[state.P + 1] === 1)
                        register[code[state.P + 2]] = fresh; // also set X(i) if X-register
                }

                if(state.H > maxHeapSize) {
                    maxHeapSize = state.H;
                }
            }
            state.P += 3;
            if (did_fail)
                if (!backtrack())
                    return wamExit(false);
        }
        continue;

        case 26: // unify_constant
            if (state.mode === READ)
            {
                wamValidHeapOrStackAddr('read S', state.S, 'unify_constant');
                let sym = deref(memory[state.S++]); // the state.s++ increment is as indicated by Ait-Kaci wamerratum.txt.
                let arg = code[state.P+1] ^ (TAG_ATM << WORD_BITS);
                state.P += 2;
                debug_msg("sym: " + hex(sym) + ", arg: " + hex(arg));
                if (TAG(sym) === TAG_REF)
                {
                    debug_msg("Binding " + sym + " and " + arg);
                    bind(sym, arg);
                }
                else if (sym !== arg)
                    if (!backtrack())
                        return wamExit(false);
            }
            else
            {
                wamValidHeapAddr('heap top', state.H, 'unify_constant');
                memory[state.H++] = code[state.P+1] ^ (TAG_ATM << WORD_BITS);
                if(state.H > maxHeapSize) {
                    maxHeapSize = state.H;
                }
                state.P += 2;
            }
            continue;
        case 27: // unify_integer
            if (state.mode === READ)
            {
                wamValidHeapOrStackAddr('read S', state.S, 'unify_integer');
                let sym = deref(memory[state.S++]);
                let arg = (code[state.P+1] & ((1 << WORD_BITS)-1)) ^ (TAG_INT << WORD_BITS);
                state.P += 2;
                if (TAG(sym) === TAG_REF)
                {
                    debug_msg("Binding " + sym + " and " + arg);
                    bind(sym, arg);
                }
                else if (sym !== arg)
                    if (!backtrack())
                        return wamExit(false);
            }
            else
            {
                wamValidHeapAddr('heap top', state.H, 'unify_integer');
                memory[state.H++] = (code[state.P+1] & ((1 << WORD_BITS)-1)) ^ (TAG_INT << WORD_BITS);
                if(state.H > maxHeapSize) {
                    maxHeapSize = state.H;
                }
                state.P += 2;
            }
            continue;

        case 28: // try_me_else
        {
            debug_msg("try_me_else at P=" + state.P + " which has branch=" + code[state.P + 1]);
            // We need to allocate a new choicepoint, but first we need to determine /where/ to put it, since we do not keep a reference to the top of the stack.
            // The last item on the stack is either an environment, or a choicepoint.

            let next = code[state.P + 1];
            let nextCP;
            if ((next & 0x80000000) === 0) {
                // next is a clause index in the current predicate
                nextCP = {
                    code: state.current_predicate.clauses[next].code,
                    predicate: state.current_predicate,
                    offset: 0
                };
            } else {

                // next is an absolute address in the current clause: Used for auxiliary clauses only
                nextCP = {
                    code: code,
                    predicate: state.current_predicate,
                    offset: next ^ 0x80000000
                };
            }

            wam_create_choicepoint(nextCP, []);

            state.P += 2;
            debug_msg("try_me_else: state.B is now at " + state.B + " and state.HB is now " + state.HB);
        }
            continue;
        case 29: // retry_me_else
        {
            // Unwind the last goal. The arity if the first thing on the stack, then the saved values for A1...An
            wamValidStackAddr('choicepoint arity', state.B, 'retry_me_else');
            let arity = memory[state.B];
            debug_msg("retry_me_else: " + state.B + " with saved register count " + memory[state.B] + " and retry point " + code[state.P + 1]);
            wamValidStackAddr('choicepoint end', state.B + arity + CP_SIZE, 'retry_me_else');
            for (let i = 0; i < arity; i++)
                register[i] = memory[state.B + i + 1];
            // Now restore all the special-purpose registers
            if (memory[state.B + arity + CP_E] < HEAP_SIZE)
                abort("Top of frame contains E which is in the heap");
            if (memory[state.B + arity + CP_E] > HEAP_SIZE + STACK_SIZE)
                abort("Top of frame contains E which exceeds the stack");
            debug_msg("top of frame at " + state.B + " is OK");
            state.E = memory[state.B + arity + CP_E];
            state.CP = memory[state.B + arity + CP_CP];
            let next = code[state.P + 1];
            debug_msg("Retry me else: Set CP to " + state.CP);
            // set up the 'else' part of retry_me_else by adjusting the saved value of B            
//            memory[state.B + arity + CP_Next] = {code: state.current_predicate.clauses[state.current_predicate.clause_keys[code[state.P+1]]].code, predicate:state.current_predicate, offset:0};
            if ((next & 0x80000000) === 0) {
                // next is a clause index in the current predicate
                memory[state.B + arity + CP_Next] = {
                    code: state.current_predicate.clauses[next].code,
                    predicate: state.current_predicate,
                    offset: 0
                };
            } else {
                // next is an absolute address in the current clause: Used for auxiliary clauses only
                memory[state.B + arity + CP_Next] = {
                    code: code,
                    predicate: state.current_predicate,
                    offset: next ^ 0x80000000
                };
            }
            unwind_trail(memory[state.B + arity + CP_TR], state.TR);

            state.TR = memory[state.B + arity + CP_TR];
            state.H = memory[state.B + arity + CP_H];
            debug_msg("case 29: state.HB <- " + state.HB);
            state.HB = state.H;
            if (state.trace_call !== 'no_trace') {
                let traceCallPL = memory[state.B + arity + CP_TC];
                state.trace_call = atable[VAL(traceCallPL)];
                if(! state.trace_call) {
                    throw 'retry_me_else backtrack trace_call is undefined';
                }
                debug_msg("Set state.trace_call " + state.trace_call + " from choicepoint at " + state.B);
                state.trace_info = memory[state.B + arity + CP_TI];
            }
            state.P += 2;
        }
            continue;
        case 30: // trust_me
        {
            // Unwind the last goal. The arity if the first thing on the stack, then the saved values for A1...An
            wamValidStackAddr('choicepoint arity', state.B, 'trust_me');
            let n = memory[state.B];
            debug_msg("trusting last clause: " + state.B + " with saved register count " + memory[state.B] + " and HB was " + state.HB + ". Choicepoint has " + n + " saved registers.");
            wamValidStackAddr('choicepoint end', state.B + n + CP_SIZE, 'trust_me');
            for (let i = 0; i < n; i++) {
                debug_msg("Restoring register " + i + " to " + hex(memory[state.B + i + 1]));
                register[i] = memory[state.B + i + 1];
            }
            // Now restore all the special-purpose registers
            if (memory[state.B + n + CP_E] < HEAP_SIZE || memory[state.B + n + CP_E] > HEAP_SIZE + STACK_SIZE)
                abort("Top of frame exceeds bounds in trust. Read from memory[" + (state.B + n + CP_E) + "]. State.B is " + state.B);
            state.E = memory[state.B + n + CP_E];
            state.CP = memory[state.B + n + CP_CP];
            debug_msg("trust_me: Set CP to " + state.CP);
            unwind_trail(memory[state.B + n + CP_TR], state.TR);
            state.TR = memory[state.B + n + CP_TR];
            state.H = memory[state.B + n + CP_H];
            if (state.trace_call !== 'no_trace') {
                let traceCallPL = memory[state.B + n + CP_TC];
                state.trace_call = atable[VAL(traceCallPL)];
                if(! state.trace_call) {
                    throw 'trust_me backtrack trace_call is undefined';
                }
                debug_msg("state.trace_call is now set back to " + state.trace_call + " from choicepoint at " + state.B);
                state.trace_info = memory[state.B + n + CP_TI];
            }
            state.B = memory[state.B + n + CP_B];
            if(state.B === 0) {
                state.HB = 0;
            } else {
                wamValidStackAddr('previous choicepoint heap addr', state.B + memory[state.B] + CP_H, 'trust_me');
                state.HB = memory[state.B + memory[state.B] + CP_H];
            }
            debug_msg("state.B is now set back to " + state.B + " and state.HB is set back to " + state.HB);
            debug_msg("state.E is now set back to " + state.E);
            debug_msg("case 30: state.HB reset to " + state.HB);
            state.P += 2;
        }
            continue;

        case 31: // neck_cut
        {
            // Move B back to B0 and tidy the trail. If B == B0 then do nothing (ie if there is a useless cut in the only clause of a predicate)
            let result = true;
            if (state.B > state.B0) {
                while (cleanups[0] !== undefined && cleanups[0].B > state.B0 && cleanups[0].B < state.B) {
                    result = run_cleanup(cleanups[0]) && result;
                    cleanups.shift();
                }
                state.B = state.B0;
                if (state.B > 0) {
                    wamValidStackAddr('previous choicepoint heap addr', state.B + memory[state.B] + CP_H, 'neck_cut');
                    state.HB = memory[state.B + memory[state.B] + CP_H]; // fix from wamerratum.txt
                    tidy_trail();
                }
            }
            if (result)
                state.P += 1;
            else if (!backtrack())
                return wamExit(false);
        }
            continue;
        case 32: // cut(I)
        {
            let register_location32 = state.E + 2 + code[state.P + 1];
            wamValidStackVarAddr('stack environment var Y', code[state.P+1], register_location32, 'cut');
            let y = VAL(memory[register_location32]);
            debug_msg("cut(Y" + code[state.P + 1] + "). B = " + state.B + " B0 = " + state.B0);
            debug_msg("Cutting to memory[" + register_location32 + "] = " + y);
            let result = true;
            if (state.B > y) {
                while (cleanups[0] !== undefined && cleanups[0].B > y && cleanups[0].B < state.B0) {
                    debug_msg("Cutting to " + y + ", and top cleanup is protecting " + cleanups[0].B + " so executing " + cleanups[0].P);
                    debug_msg("State is currently " + JSON.stringify(state));
                    result = run_cleanup(cleanups[0]) && result;
                    cleanups.shift();
                }
                state.B = y;
                if (state.B > 0) {
                    wamValidStackAddr('previous choicepoint heap addr', state.B + memory[state.B] + CP_H, 'cut');
                    state.HB = memory[state.B + memory[state.B] + CP_H]; // fix from wamerratum.txt
                    tidy_trail();
                }
            } else {
                debug_msg("... has no effect");
            }
            debug_msg("Cut complete. State is " + JSON.stringify(state));
            if (result)
                state.P += 2;
            else if (!backtrack())
                return wamExit(false);
            // noinspection UnnecessaryContinueJS
            continue;
        }

        case 33: // get_level(I)
            debug_msg("Setting memory[" + (state.E + 2 + code[state.P+1]) + "] to B0: " + state.B0 + " (state.B = " + state.B + ")");
            let register_location33 = state.E + 2 + code[state.P + 1];
            wamValidStackVarAddr('stack environment var Y', code[state.P+1], register_location33, 'get_level');
            memory[register_location33] = state.B0 ^ (TAG_INT << WORD_BITS);
            state.P += 2;
            continue;

        case 40: // call_aux
            offset = code[state.P+1];
            state.CP = {code:code,
                        predicate: state.current_predicate,
                        offset:state.P + 4};
            debug_msg("Call_aux: Set CP to " + state.CP);
            debug_msg("Aux offset is " + offset);
            debug_msg("env space still required: " + code[state.P+3]);
            state.num_of_args = code[state.P+2];
            state.P = offset;
            state.B0 = state.B;
            continue;

        case 41: // execute_aux
            offset = code[state.P+1];
            state.num_of_args = code[state.P+2];
            state.P = offset;
            state.B0 = state.B;            
            continue;

        case 42: // retry_foreign
        {
            debug_msg("retry_foreign from " + state.B);
            wamValidStackAddr('choicepoint specials', state.B + FCP_C, 'retry_foreign');
            state.foreign_value = memory[state.B + FCP_V];
            state.P = memory[state.B + FCP_C].offset;
            code = memory[state.B + FCP_C].code;
            if (!code) {
                throw 'code is undefined';
            }

            state.current_predicate = memory[state.B + FCP_C].current_predicate;
            if(state.current_predicate) {
                state.num_of_args = ftable[state.current_predicate.key][1];
            }

            let n = memory[state.B];
            debug_msg("State has " + n + " saved registers including the two special");
            wamValidStackAddr('choicepoint end', state.B + n + CP_SIZE, 'retry_foreign');
            state.foreign_retry = true;
            for (let i = 0; i <= n - FCP_R; i++) {
                debug_msg("Restoring register " + i + " from memory[" + (state.B + FCP_R + i) + "] = " + hex(memory[state.B + FCP_R + i]) + " which is " + term_to_string(memory[state.B + FCP_R + i]));
                register[i] = memory[state.B + FCP_R + i];
            }
            state.E = memory[state.B + n + CP_E];
            state.CP = memory[state.B + n + CP_CP];
            unwind_trail(memory[state.B + n + CP_TR], state.TR);
            state.TR = memory[state.B + n + CP_TR];
            state.H = memory[state.B + n + CP_H];
            state.HB = state.H;
            if (state.trace_call !== 'no_trace') {
                let traceCallPL = memory[state.B + n + CP_TC];
                state.trace_call = atable[VAL(traceCallPL)];
                if(! state.trace_call) {
                    throw 'retry_foreign backtrack trace_call is undefined';
                }
                debug_msg("state.trace_call is now set back to " + state.trace_call + " from choicepoint at " + state.B);
                state.trace_info = memory[state.B + n + CP_TI];
            }
        }
            continue;
        case 43: // get_choicepoint
        {
            let i = code[state.P + 1];
            let max = i;
            let choice = state.B;
            while (i !== 0) {
                let ordinal = max - i;
                let suffix = ordinal === 1 ? 'st' : ordinal === 2 ? 'nd' : ordinal === 3 ? 'rd' : 'th';
                wamValidStackAddr(ordinal + suffix + ' previous choicepoint base', choice, 'get_choicepoint');
                choice = memory[choice + memory[choice] + CP_B];
                i--;
            }

            let register_location43 = state.E + 2 + code[state.P + 2];
            debug_msg("Setting " + register_location43 + " to " + max + "-to-top choicepoint " + choice);
            wamValidStackVarAddr('stack environment var Y', code[state.P+2], register_location43, 'get_level');
            memory[register_location43] = (choice ^ TAG_INT << WORD_BITS);
            state.P += 3;
        }
            continue;

            case 44: // switch_on_term: [44, V, CA, CI, CF, L, S]
        {
            let codePosition = state.P;
            let argument1 = deref(register[0]);

            let V = code[codePosition + 1];
            let CA = code[codePosition + 2];
            let CI = code[codePosition + 3];
            let CF = code[codePosition + 4];
            let L = code[codePosition + 5];
            let S = code[codePosition + 6];

            switch(TAG(argument1)) {
                case TAG_REF:
                    gotoAddress(V, 0); break; // offset = 0 directs gotoAddress to start with control instruction of 'address' (clause index) V.
                case TAG_ATM:
                    if(CA !== FAIL_ADDRESS) {
                        gotoAddress(CA);
                    } else if (!backtrack())
                        return wamExit(false);
                    break;
                case TAG_FLT:
                    if(CF !== FAIL_ADDRESS) {
                        gotoAddress(CF);
                    } else if (!backtrack())
                        return wamExit(false);
                    break;
                case TAG_INT:
                    if(CI !== FAIL_ADDRESS) {
                        gotoAddress(CI);
                    } else if (!backtrack())
                        return wamExit(false);
                    break;
                case TAG_LST:
                    if(L !== FAIL_ADDRESS) {
                        gotoAddress(L);
                    } else if (!backtrack())
                        return wamExit(false);
                    break;
                case TAG_STR:
                    if(S !== FAIL_ADDRESS) {
                        gotoAddress(S);
                    } else if (!backtrack())
                        return wamExit(false);
                    break;
                default:
                    throw('invalid TAG ' + TAG(argument1) + ' on argument1 with value ' + VAL(argument1));
            }
        }
        continue;

            case 45: // switch_on_constant: [45, T, ...]
        {
            let codePosition = state.P;
            let argument1 = VAL(deref(register[0])); // the table is all of one data type: atom, integer, or float.
            let T = code[codePosition + 1];
            let result = search_table_type(T, argument1, codePosition + 2);

            if(result.found) {
                gotoAddress(result.value);
            } else  if (!backtrack()) {
                return wamExit(false);
            }
        }
        continue;

            case 46: // switch_on_structure: [46, T, ...]
        {
            let codePosition = state.P;
            let argument1 = deref(register[0]);
            wamValidHeapOrStackAddr('switch argument', VAL(argument1), 'switch_on_structure');
            let predicateIndicator = VAL(memory[VAL(argument1)]);
            let T = code[codePosition + 1];
            let result = search_table_type(T, predicateIndicator, codePosition + 2);
            if(result.found) {
                gotoAddress(result.value);
            } else if (!backtrack()) {
                return wamExit(false);
            }
        }
            continue;

        case 71: // try: [71, L]
        {
            let codePosition = state.P;
            let L = code[codePosition + 1];
            let nextCP = {
                code: code,
                predicate: state.current_predicate,
                offset: state.P + 2
            };
            wam_create_choicepoint(nextCP, []);
            gotoAddress(L);
        }
        continue;

        case 72: // retry: [72, L]
        {
            let codePosition = state.P;
            let L = code[codePosition + 1];
            // Unwind the last goal. The arity if the first thing on the stack, then the saved values for A1...An
            wamValidStackAddr('choicepoint base', state.B, 'retry');
            let arity = memory[state.B];
            wamValidStackAddr('choicepoint end', state.B + arity + CP_SIZE, 'retry');
            debug_msg("retry: " + state.B + " with saved register count " + memory[state.B] + " and retry point " + code[state.P + 1]);
            for (let i = 0; i < arity; i++)
                register[i] = memory[state.B + i + 1];
            // Now restore all the special-purpose registers

            wamValidStackAddr('choicepoint environment', memory[state.B + arity + CP_E], 'retry');

            debug_msg("top of frame at " + state.B + " is OK");
            state.E = memory[state.B + arity + CP_E];
            state.CP = memory[state.B + arity + CP_CP];
            let next = state.P + 2;

            debug_msg("Retry: Set CP to " + state.CP);

            memory[state.B + arity + CP_Next] = {
                    code: code,
                    predicate: state.current_predicate,
                    offset: next
                };

            unwind_trail(memory[state.B + arity + CP_TR], state.TR);

            state.TR = memory[state.B + arity + CP_TR];
            state.H = memory[state.B + arity + CP_H];
            debug_msg("case 72: state.HB <- " + state.HB);
            state.HB = state.H;
            if (state.trace_call !== 'no_trace') {
                let traceCallPL = memory[state.B + arity + CP_TC];
                state.trace_call = atable[VAL(traceCallPL)];
                if(! state.trace_call) {
                    throw 'retry backtrack trace_call is undefined';
                }
                debug_msg("Set state.trace_call " + state.trace_call + " from choicepoint at " + state.B);
                state.trace_info = memory[state.B + arity + CP_TI];
            }
            gotoAddress(L);
        }
            continue;

        case 73: // trust(L)
        {
            let codePosition = state.P;
            let L = code[codePosition + 1];
            // Unwind the last goal. The arity if the first thing on the stack, then the saved values for A1...An
            wamValidStackAddr('choicepoint base', state.B, 'trust');
            let n = memory[state.B];
            wamValidStackAddr('choicepoint end', state.B + n + CP_SIZE, 'trust');
            debug_msg("trusting last clause: " + state.B + " with saved register count " + memory[state.B] + " and HB was " + state.HB + ". Choicepoint has " + n + " saved registers.");
            for (let i = 0; i < n; i++) {
                debug_msg("Restoring register " + i + " to " + hex(memory[state.B + i + 1]));
                register[i] = memory[state.B + i + 1];
            }
            // Now restore all the special-purpose registers
            wamValidStackAddr('choicepoint environment', memory[state.B + n + CP_E], 'trust');
            state.E = memory[state.B + n + CP_E];
            state.CP = memory[state.B + n + CP_CP];
            debug_msg("trust: Set CP to " + state.CP);
            unwind_trail(memory[state.B + n + CP_TR], state.TR);
            state.TR = memory[state.B + n + CP_TR];
            state.H = memory[state.B + n + CP_H];
            if (state.trace_call !== 'no_trace') {
                let traceCallPL = memory[state.B + n + CP_TC];
                state.trace_call = atable[VAL(traceCallPL)];
                if(! state.trace_call) {
                    throw 'trust backtrack trace_call is undefined';
                }
                debug_msg("state.trace_call is now set back to " + state.trace_call + " from choicepoint at " + state.B);
                state.trace_info = memory[state.B + n + CP_TI];
            }
            state.B = memory[state.B + n + CP_B];
            if(state.B === 0) {
                state.HB = 0;
            } else {
                wamValidStackAddr('previous choicepoint heap addr', state.B + memory[state.B] + CP_H, 'trust');
                state.HB = memory[state.B + memory[state.B] + CP_H];
            }
            debug_msg("state.B is now set back to " + state.B + " and state.HB is set back to " + state.HB);
            debug_msg("state.E is now set back to " + state.E);
            debug_msg("case 73: state.HB reset to " + state.HB);
            gotoAddress(L);
        }
            continue;

            // All the floating point operations are here because I added them as an afterthought!
        case 50: // get_float I from Ai
        sym = deref(register[code[state.P+2]]);
        arg = code[state.P+1] ^ (TAG_FLT << WORD_BITS);
        state.P += 3;
        if (TAG(sym) === TAG_REF)
        {
            // If Ai is variable, then we need to bind. This is when foo(7) is called like foo(X).
            bind(sym, arg);
        }
        else if (sym !== arg)
        {
            debug_msg("Could not get constant: " + hex(sym) + " from " + hex(arg));
            if (!backtrack())
                return wamExit(false);
        }
        continue;

        case 74: //    goto_clause: [74, L]
        {
            gotoAddress(code[state.P + 1]);
        }
        continue;

        case 51: // put_float I into Ai
            register[code[state.P+2]] = code[state.P+1] ^ (TAG_FLT << WORD_BITS);
            state.P += 3;
            continue;

        case 52: // unify_float
            if (state.mode === READ)
            {
                wamValidHeapOrStackAddr('read S', state.S, 'unify_float');
                sym = deref(memory[state.S++]);
                arg = code[state.P+1] ^ (TAG_FLT << WORD_BITS);
                state.P += 2;
                if (TAG(sym) === TAG_REF)
                {
                    bind(sym, arg);
                }
                else if (sym !== arg)
                    if (!backtrack())
                        return wamExit(false);
            }
            else
            {
                wamValidHeapAddr('heap top', state.H, 'unify_float');
                memory[state.H++] = code[state.P+1] ^ (TAG_FLT << WORD_BITS);
                if(state.H > maxHeapSize) {
                    maxHeapSize = state.H;
                }
                state.P += 2;
            }
            continue;

        case 60: // put_variable Yn
        {
            // Note that this is different from put_variable(Yn, Ai) in that it ONLY puts a fresh variable into Yn
            // This is needed to make garbage collection safe
            let register_location60 = state.E + code[state.P + 1] + 2;
            debug_msg("Putting new variable into Y" + code[state.P + 1] + " at " + register_location60);
            wamValidStackVarAddr('new var Y', code[state.P + 1], register_location60, 'put_variable');
            memory[register_location60] = register_location60 ^ (TAG_REF << WORD_BITS);
            state.P += 2;
            // noinspection UnnecessaryContinueJS
            continue;
        }
            

        case 254: // Only clause: NOP
            state.P += 2;
            continue;
        case 255: // halt
            state.running = false;
            continue;
        default:
            abort("unexpected opcode at P=" + (((state.current_predicate == null)?("no predicate"):(atable[ftable[state.current_predicate.key][0]] + "/" + ftable[state.current_predicate.key][1])) + "@" + state.P + ": " + code[state.P]));
        }        
    }
    return wamExit(true);
}

function gotoAddress(address, offset) {
    if((address & 0x80000000) === 0) {
        // address is a clause index in current predicate. 'Go' to that clause and set the
        // program pointer to skip the first instruction (two words): this
        // instruction is always NOP, try_me_else, retry_me_else, or trust_me.
        code = state.current_predicate.clauses[state.current_predicate.clause_keys[address]].code;
        if(! code) {
            throw('code is undefined for gotoAddress '+ address + '.');
        }
        let skip;
        if(typeof offset === 'undefined') {
            skip = 2; // skip the opening control instruction (e.g. try_me_else).
        } else {
            skip = offset;
        }
        state.P = skip;
    } else {
        // address is a position in the current clause code.
        state.P = address ^ 0x80000000;
        if(! code[state.P]) {
            throw('instruction ' + state.P + ' undefined for code of gotoAddress.');
        }
    }
}

function search_table_type(type, value, tableStartPosition) {
    // There are two types of tables: hash and key/value pair sequence.

    let tableSize = code[tableStartPosition];
    if(type === 0) {
        // key/value pair sequence
        return search_table(value, tableStartPosition+1, tableSize);
    } else if(type === 1) {
        return search_table_hash(value, tableStartPosition+1, tableSize);
    } else {
        throw('invalid search table type: ' + type);
    }
}

function search_table(value, tableStartPosition, tableSize) {
    // The table is a sequence of tableSize pairs of key-value words
    // starting at code[tableStartPosition].
    // The pairs are in Prolog term order by keys.
    // For a large table this function can use a binary search.
    // For small tables it is sufficient to do a linear search.

    if(tableSize > 15) {
        return search_table_binary(value, tableStartPosition, tableSize);
    }

    let limit = (tableSize*2)+tableStartPosition;
    for(let searchPosition = tableStartPosition;searchPosition < limit;searchPosition+=2) {
        let key = code[searchPosition];
        if(key === value) {
            return {found: true, value: code[searchPosition+1]};
        }
    }

    return {found: false};
}

function search_table_binary(value, tableStartPosition, tableSize) {
    // The table is a sequence of tableSize pairs of key-value words
    // starting at code[tableStartPosition].
    // The pairs are in Prolog term order by keys.
    // For a large table this function can use a binary search.
    // For small tables it is sufficient to do a linear search.

    let searchLimit = tableSize;
    let searchLimitSuccessor = searchLimit + 1;
    let searchID = searchLimitSuccessor / 2;
    let reducedTableStartPosition = tableStartPosition - 2;
    let found;
    let searchPosition;
    while(true) {
        searchPosition = searchID*2 + reducedTableStartPosition;
        let key = code[searchPosition];
        let comparison = value - key;
        if(comparison < 0) {
            if(searchID === 1) {
                found = false;
                break;
            }
            searchID = (searchID-1) / 2;
        } else if(comparison > 0) {
            if(searchID === searchLimit) {
                found = false;
                break;
            }
            searchID = (searchID + searchLimitSuccessor) / 2;
        } else {
            // comparison === 0 -> value === key
            found = true;
            break;
        }
    }

    if(found) {
        return {found: true, value: code[searchPosition+1]};
    }
    return {found: false};
}

function search_table_hash(value, tableStartPosition, tableSize) {
    // The table is in two layers.
    // The top layer is a sequence of tableSize 'buckets' (tableSize is a power of 2) - each
    // bucket is an address of a second layer table.
    // A second layer table has a word at code[address] with tableSize followed
    // by a sequence of tableSize pairs of key-value words
    // starting at code[address+1].
    // The pairs are in Prolog term order by keys.
    // For a large table this function can use a binary search.
    // For small tables it is sufficient to do a linear search.

    // tableSize bucket hash. Key is 0 to tableSize-1.
    // hash is low order log2(tableSize) bits.

    let mask = tableSize - 1;

    let bucketID = (value & mask) + 1;
    let bucketOfst = bucketID - 1;
    let bucketPosition = tableStartPosition + bucketOfst;
    let subtableAddress = code[bucketPosition] ^ 0x80000000; // subtableAddress in code is from 'linking' a label.
    let subtableSize = code[subtableAddress];
    let subtableStartPosition = subtableAddress + 1;
    return search_table(value, subtableStartPosition, subtableSize)
}

function predicate_suspend_set(value) {
    return suspend_set(atable[VAL(value)]);
}

function suspend_set(value) {
    state.suspended = (value === 'true');
    debug_msg("suspend_set: state.suspended is now set to " + state.suspended );
    return true;
}

function instruction_suspend_set(value) {
    state.instruction_suspended = (value === 'true');
    debug_msg("instruction_suspend_set: state.instruction_suspended is now set to " + state.instruction_suspended );
    return true;
}

function predicate_trace_set(value) {
    state.trace_call = atable[VAL(value)];
    if(! state.trace_call) {
        throw 'predicate_trace_set trace_call is undefined';
    }
    debug_msg("predicate_trace_set: state.trace_call is now set to " + state.trace_call );
    return true;
}

function predicate_trace_value(value) {
    return unify(value, lookup_atom(state.trace_call));
}

function predicate_trace_set_info(term) {
    state.trace_info = term;
    //stdout('info: ' + term_to_string(term) + '\n');
    return true;
}

function predicate_trace_instruction_set(value) {
    state.trace_instruction = atable[VAL(value)];
    debug_msg("predicate_trace_instruction_set: state.trace_instruction is now set to " + state.trace_instruction );
    return true;
}

/* Testing */

function hex(number)
{
    if (number === undefined)
        return "undefined";
    if (number < 0)
    {
    	number = 0xFFFFFFFF + number + 1;
    }
    if (typeof number !== 'number') {
        return "NaN";
    }
    // noinspection JSCheckFunctionSignatures
    return "0x" + number.toString(16).toUpperCase();
}

function allocate_first_frame()
{
    // Allocate an environment for the toplevel?
    state.E = HEAP_SIZE; 
    memory[state.E] = 0;     // previous environment = NULL
    memory[state.E + 1] = state.CP;
}

function term_to_string(t)
{
    return format_term(t, {ignore_ops:false, quoted: true, numbervars: false});
}

function copy_state(s)
{
    return {H: s.H,
            HB: s.HB,
            S: s.S,
            P: s.P,
            CP: s.CP, 
            B0: s.B0,
            B: s.B,
            E: s.E,
            TR: s.TR,
            mode: s.mode,
            running: s.running,
            num_of_args: s.num_of_args,
            foreign_retry: s.foreign_retry,
            foreign_value: s.foreign_value,
            current_predicate: s.current_predicate,
            trace_call: s.trace_call,
            trace_predicate: s.trace_predicate,
            trace_code: s.trace_code,
            trace_info: s.trace_info,
            trace_prompt: s.trace_prompt,
            suspended: s.suspended};
}

function copy_registers(r)
{
    return r.slice(0);
}

function copy_memory(m) {
    return m.slice(0);
}


function run_cleanup(c)
{
    debug_msg("Running cleanup...: " + JSON.stringify(c));
    let saved_state = copy_state(state);
    let saved_registers = copy_registers(register);
    let saved_code = code;
    state.P = c.P;
    register = c.V.slice(0);
    code = c.code;
    debugging = true;
    let result = true;

    if (!wam())
    {
        // Failure is ignored, but exceptions are raised
        if (exception != null)
            result = false;
    }
    debug_msg("Finished. Restoring state. Heap is up to " + state.H);
    register = copy_registers(saved_registers);
    let saved_heap = state.H;
    state = copy_state(saved_state);
    state.H = saved_heap;
    code = saved_code;
    return result;
}

// Exceptions are implemented as the 'compromise' solution in Bart Demoen's 1989 paper
// http://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.57.4354&rep=rep1&type=pdf
function predicate_throw(t)
{
    debug_msg("Setting exception " + hex(t) + "=> "+ term_to_string(t));
    exception = record_term(t);
    return unwind_stack();
}

function unwind_stack()
{
    if (state.block === undefined)
    {
        abort("Uncaught exception: " + term_to_string(recall_term(exception, {})));
    }
    state.B = state.block;
    return false;
}

function get_current_block(b)
{
    return unify(b, state.block ^ (TAG_INT << WORD_BITS));
}

function install_new_block(nb)
{
    state.block = state.B;
    return unify(nb, state.B ^ (TAG_INT << WORD_BITS));
}

function reset_block(x)
{
    state.block = VAL(x);
    return true;
}

function clean_up_block(nb)
{
    // If alternative to B is nb, then select it now
    if (memory[state.B+memory[state.B]+CP_B] === VAL(nb))
        state.B = VAL(memory[VAL(nb)+memory[VAL(nb)]+CP_B]);
    return true;

}
function get_exception(e)
{
    if (exception !== null)
    {
        return unify(e, recall_term(exception, {}));
    }
    else
    {
        return false;
    }
}

function clear_exception()
{
    exception = null;
    return true;
}

function undefined_predicate(ftor)
{
    if (prolog_flag_values.unknown === "error")
    {
        let indicator = state.H ^ (TAG_STR << WORD_BITS);
        memory[state.H++] = lookup_functor("/", 2);
        memory[state.H++] = ftable[ftor][0] ^ (TAG_ATM << WORD_BITS);
        memory[state.H++] = ftable_arity(ftor) ^ (TAG_INT << WORD_BITS);
        if(state.H > maxHeapSize) {
            maxHeapSize = state.H;
        }
        existence_error("procedure", indicator);
    }
    else if (prolog_flag_values.unknown === "warning")
    {
        stdout("Undefined predicate " + atable[ftable[ftor][0]] + "/" + ftable_arity(ftor) + "\n");
    }
    if (!backtrack())
    {
        debug("Could not backtrack");
        return false;
    }
    return true;
}

// End exceptions code

function reset_compile_buffer()
{
    compilation_environment.buffer = [];
    return true;
}

function predicate_compile_buffer_codes(codes) {
    let currentCodes;
    if(typeof compilation_environment.buffer === 'undefined' || compilation_environment.buffer.length === 0) {
        currentCodes = NIL;
    } else {
        currentCodes = integers_to_list(compilation_environment.buffer);
    }

    return unify(codes, currentCodes);
}

function predicate_indexing_mode(mode) {
    if(typeof compilation_environment.indexing_mode === 'undefined') {
        return unify(mode, PL_new_atom('basic'));
    }

    return unify(mode, PL_new_atom(compilation_environment.indexing_mode));
}

function predicate_set_indexing_mode(mode) {
    if(TAG(mode) === TAG_REF) {
        return instantiation_error('indexing mode atom', mode);
    }

    if(TAG(mode) !== TAG_ATM) {
        return type_error('indexing mode atom', mode);
    }

    let modeJS = PL_atom_chars(mode);

    if(modeJS !== 'none' && modeJS !== 'basic') {
        return domain_error('indexing mode atom = "none" or "basic"', mode);
    }

    compilation_environment.indexing_mode = modeJS;
    return true;
}

function predicate_compiled_state_boot_code(bootCode)
{
    if(TAG(bootCode) !== TAG_REF && TAG(bootCode) !== TAG_LST) {
        return type_error('var or list', bootCode);
    }
    let list = integers_to_list(bootstrap_code);
    return unify(bootCode, list);
}


function integers_to_list(integers) {
    if(integers.length === 0) {
        return NIL;
    }

    let tmp = state.H ^ (TAG_LST << WORD_BITS);
    for (let i = 0; i < integers.length; i++)
    {
        memory[state.H] = integers[i] ^ (TAG_INT << WORD_BITS);
        // If there are no more items we will overwrite the last entry with [] when we exit the loop
        memory[state.H+1] = ((state.H+2) ^ (TAG_LST << WORD_BITS));
        state.H += 2;
    }
    memory[state.H-1] = NIL;
    return tmp;
}

function terms_to_list(terms) {
    if(terms.length === 0) {
        return NIL;
    }

    let tmp = state.H ^ (TAG_LST << WORD_BITS);
    for (let i = 0; i < terms.length; i++)
    {
        memory[state.H] = terms[i];
        // If there are no more items we will overwrite the last entry with [] when we exit the loop
        memory[state.H+1] = ((state.H+2) ^ (TAG_LST << WORD_BITS));
        state.H += 2;
    }
    memory[state.H-1] = NIL;
    return tmp;
}
function strings_to_atom_list(strings) {
    if(strings.length === 0) {
        return NIL;
    }

    let tmp = state.H ^ (TAG_LST << WORD_BITS);
    for (let i = 0; i < strings.length; i++)
    {
        memory[state.H] = lookup_atom(strings[i]);
        // If there are no more items we will overwrite the last entry with [] when we exit the loop
        memory[state.H+1] = ((state.H+2) ^ (TAG_LST << WORD_BITS));
        state.H += 2;
    }
    memory[state.H-1] = NIL;
    return tmp;
}

function log(target, msg) {
    if(target !== 'none') {
        if (target === 'console') {
            dumpWrite(msg);
        } else if (target === 'local_storage') {
            logToLocalStorage(msg);
        } else if (target === 'local_storage_ring') {
            log_ring(msg);
        } else {
            throw 'invalid log target: ' + target;
        }
    }
}
