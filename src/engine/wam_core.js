"use strict";

let memory = new Array(HEAP_SIZE + STACK_SIZE + TRAIL_SIZE);
let code = [255];
let register = new Array(256);
let state;

// Stack for managing cleanup handlers needed during a cut
let cleanups = [];

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

function wam() {
    try {
        return wam1();
    } catch(e) {
        wamExit(e);
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
                if (tmpE < HEAP_SIZE ) {
                    abort("Top of frame less than minimum stack address (HEAP_SIZE=" + HEAP_SIZE + ") in allocate: " + hex(tmpE));
                } else if (tmpE > HEAP_SIZE + STACK_SIZE) {
                    // dump_environments();
                    // dump_choicepoints();
                    abort("Top of frame greater than maximum stack address (HEAP_SIZE+STACK_SIZE="+HEAP_SIZE+"+"+STACK_SIZE+"="+(HEAP_SIZE+STACK_SIZE) + ") in allocate: " + hex(tmpE));
                }

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
                if (memory[state.E] < HEAP_SIZE || memory[state.E] > HEAP_SIZE + STACK_SIZE)
                    abort("Top of frame " + memory[state.E] + " exceeds bounds in deallocate. Environment is " + state.E + " P = " + state.P);

                state.E = memory[state.E];
                debug_msg("Deallocate: E is reduced to " + state.E);
                state.P += 1;
                continue;

            case 3: // call

                functor = atable[ftable[code[state.P + 1]][0]];
                if (    (state.trace_call === "trace" || state.trace_call === "leap_trace") &&
    ! functor.startsWith("debugger:") && ! functor.startsWith("system:$trace") &&
    ! state.foreign_retry &&
    functor !== "true" && functor !== "system:true" && state.trace_predicate  // trace_or_call_execute(functor)
) {
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
                        // 'trace_next' and 'leap_trace_next' only occur when call/1 is invoked by '$trace'.
    if (state.trace_call === 'trace_next') {
        state.trace_call = 'trace';
        debug_msg("Set state.trace_call from 'trace_next' to " + state.trace_call);
    } else if (state.trace_call === 'leap_trace_next') {
        state.trace_call = 'leap_trace';
        debug_msg("Set state.trace_call from 'leap_trace_next' to " + state.trace_call);
    }



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

                if (    (state.trace_call === "trace" || state.trace_call === "leap_trace") &&
    ! functor.startsWith("debugger:") && ! functor.startsWith("system:$trace") &&
    ! state.foreign_retry &&
    functor !== "true" && functor !== "system:true" && state.trace_predicate  // trace_or_call_execute(functor)
) {
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
                        // 'trace_next' and 'leap_trace_next' only occur when call/1 is invoked by '$trace'.
    if (state.trace_call === 'trace_next') {
        state.trace_call = 'trace';
        debug_msg("Set state.trace_call from 'trace_next' to " + state.trace_call);
    } else if (state.trace_call === 'leap_trace_next') {
        state.trace_call = 'leap_trace';
        debug_msg("Set state.trace_call from 'leap_trace_next' to " + state.trace_call);
    }



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
                let register_location = state.E + code[state.P + 1] + 2;
                debug_msg("Putting new variable into Y" + code[state.P + 1] + " at " + register_location);
                memory[register_location] = register_location ^ (TAG_REF << WORD_BITS);
                register[code[state.P + 2]] = register_location ^ (TAG_REF << WORD_BITS);
                state.P += 3;
                // noinspection UnnecessaryContinueJS
                continue;
            }

            case 7: // put_variable: Put fresh var into registers Ai and Xn
            {

                let freshvar = state.H ^ (TAG_REF << WORD_BITS);
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
                let register_location = state.E + code[state.P+2] + 2;
                if (memory[register_location] === undefined)
                    abort("Invalid memory access in put_value");
                register[code[state.P+3]] = memory[register_location];
                debug_msg("put_value(Y" + code[state.P+2] + ", A" + code[state.P+3] + "): memory[" + register_location + "] = "  + hex(memory[register_location]));
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
            let register_location = state.E + code[state.P + 1] + 2;
            // This is the unsafe bit. If the value now in register[code[state.P+2]] is on the stack (that is, it is > E) then we have to push a new variables
            // onto the stack to avoid dangling references to things that are about to be cleaned up
            if (memory[register_location] < state.E) {
                debug_msg("Value is safe");
                // No, so we can just behave like put_value
                register[code[state.P + 2]] = deref(memory[register_location])
            } else {
                // Yes, so we need to push a new variable instead
                debug_msg("x0 memory[" + state.E + "] = " + memory[state.E]);
                debug_msg("Value is unsafe. Allocating a new unbound variable for it. It will go into Y" + code[state.P + 1] + " @ " + register_location + ". E = " + state.E);
                let v = alloc_var();
                debug_msg("x1 memory[" + state.E + "] = " + memory[state.E]);
                debug_msg("Binding " + hex(v) + " and Y" + code[state.P + 1] + " = " + hex(memory[register_location]));
                bind(v, memory[register_location]);
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
                let register_location = state.E + code[state.P+2] + 2;
                debug_msg("Y" + code[state.P+2] + " <- " + hex(register[code[state.P+3]]));
                memory[register_location] = register[code[state.P+3]];
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
                let register_location = state.E + code[state.P + 2] + 2;
                source = memory[register_location];
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
                let register_location = state.E + code[state.P+2] + 2;
                // GC: This needs to be trailed if state.B is not 0, apparently
                bind(memory[register_location], source);
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
                source = memory[state.S++];
                if (code[state.P + 1] === 0) // Y-register
                {
                    let register_location = state.E + code[state.P + 2] + 2;
                    did_fail = !unify(memory[register_location], source);
                } else {
                    did_fail = !unify(register[code[state.P + 2]], source);
                }
            } else {
                if (code[state.P + 1] === 0) // Y-register
                {
                    let register_location = state.E + code[state.P + 2] + 2;
                    memory[state.H++] = memory[register_location];
                } else {
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
                source = memory[state.S++];
                if (code[state.P + 1] === 0) // Y-register
                {
                    let register_location = state.E + code[state.P + 2] + 2;
                    did_fail = !unify(memory[register_location], source);
                } else {
                    did_fail = !unify(register[code[state.P + 2]], source);
                }
            } else {
                let addr;
                if (code[state.P + 1] === 0) // Y-register;
                {
                    let register_location = state.E + code[state.P + 2] + 2;
                    addr = memory[register_location];
                } else {
                    addr = register[code[state.P + 2]];
                }
                addr = deref(addr);
                if (VAL(addr) < state.H) {
                    debug_msg("Unify local: already safe at " + hex(addr));
                    // Address is on the heap. Just push the value onto the top of the heap
                    debug_msg(term_to_string(addr));
                    memory[state.H++] = addr;
                } else {
                    debug_msg("Unify local: unsafe. Globalizing");
                    // Address is on the stack. Push a new variable onto the heap and bind to the value
                    let fresh = state.H ^ (TAG_REF << WORD_BITS);
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
            let arity = memory[state.B];
            debug_msg("retry_me_else: " + state.B + " with saved register count " + memory[state.B] + " and retry point " + code[state.P + 1]);
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
            let n = memory[state.B];
            debug_msg("trusting last clause: " + state.B + " with saved register count " + memory[state.B] + " and HB was " + state.HB + ". Choicepoint has " + n + " saved registers.");
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
            state.HB = memory[state.B + memory[state.B] + CP_H];
            debug_msg("state.B is now set back to " + state.B + " and state.HB is set back to " + state.HB);
            debug_msg("state.E is now set back to " + state.E);
            //state.HB = memory[state.B + n + CP_H];
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
                    //state.HB = memory[state.B + memory[state.B] + CP_H]; // fix from wamerratum.txt
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
            let y = VAL(memory[state.E + 2 + code[state.P + 1]]);
            debug_msg("cut(Y" + code[state.P + 1] + "). B = " + state.B + " B0 = " + state.B0);
            debug_msg("Cutting to memory[" + (state.E + 2 + code[state.P + 1]) + "] = " + y);
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
                    //state.HB = memory[state.B + memory[state.B] + CP_H]; // fix from wamerratum.txt
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
            memory[state.E + 2 + code[state.P+1]] = state.B0 ^ (TAG_INT << WORD_BITS);
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
            let choice = state.B;
            while (i !== 0) {
                choice = memory[choice + memory[choice] + CP_B];
                i--;
            }

            debug_msg("Setting " + (state.E + 2 + code[state.P + 2]) + " to " + code[state.P + 1] + "-to-top choicepoint " + choice);
            memory[state.E + 2 + code[state.P + 2]] = (choice ^ TAG_INT << WORD_BITS);
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
            let arity = memory[state.B];
            debug_msg("retry: " + state.B + " with saved register count " + memory[state.B] + " and retry point " + code[state.P + 1]);
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
            let n = memory[state.B];
            debug_msg("trusting last clause: " + state.B + " with saved register count " + memory[state.B] + " and HB was " + state.HB + ". Choicepoint has " + n + " saved registers.");
            for (let i = 0; i < n; i++) {
                debug_msg("Restoring register " + i + " to " + hex(memory[state.B + i + 1]));
                register[i] = memory[state.B + i + 1];
            }
            // Now restore all the special-purpose registers
            if (memory[state.B + n + CP_E] < HEAP_SIZE || memory[state.B + n + CP_E] > HEAP_SIZE + STACK_SIZE)
                abort("Top of frame exceeds bounds in trust. Read from memory[" + (state.B + n + CP_E) + "]. State.B is " + state.B);
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
            state.HB = memory[state.B + memory[state.B] + CP_H];
            debug_msg("state.B is now set back to " + state.B + " and state.HB is set back to " + state.HB);
            debug_msg("state.E is now set back to " + state.E);
            //state.HB = memory[state.B + n + CP_H];
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
            let register_location = state.E + code[state.P + 1] + 2;
            debug_msg("Putting new variable into Y" + code[state.P + 1] + " at " + register_location);
            memory[register_location] = register_location ^ (TAG_REF << WORD_BITS);
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
