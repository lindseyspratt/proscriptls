:- module(tiles, [select_test/0, save_tiles/0, load_tiles/0]).

:- use_module('../library/object'). % for >>/2.
:- use_module('../library/data_predicates').
:- ensure_loaded('../library/listut2'). % for append_lists/2
:- ensure_loaded('../library/dom'). % for dom_page_offset/2

:- dynamic(is_selected/1).

% For tiles the shadow tile structure functor is 'ts'
% and the arguments are 'x', 'y', etc.
% For the game the shadow game structure functor is 'g'
% and the arguments are 'board_left', 'turn', etc.
% (Note that there is currently only one 'game' so the ID is always '1'.)

:- initialization(init).

init :-
    data_predicate_dynamics([
        data_predicates(g, game,[tile_size, board_left, board_top, board_width, board_height, board_translate, turn, replacements]), % e.g. game_board_left(ID, X)...
        data_predicates(ts, tile,[x, y,bx,by,size,colors,container]), % e.g. tile_x(ID, X), tile_y(ID, Y)...
        data_predicates(lp, legal_position, [bx, by])
    ]).

select_test :-
    _Canvas >> [id -:> canvas,
        getContext('2d') *:> Ctx,
        width +:> W,
        height +:> H,
        @ dom_page_offset(PTop, PLeft),
        addEventListener(click, [object-E]^select(E, PTop, PLeft))],

    assert_data(g(50, 10, 10, 800, 800, 1>1, 1, []), 1),
    initial_hands_expanded(2, Hands),
    setup_hands(Hands, TileIDs),
    draw_all_tiles(TileIDs, Ctx, W, H).

save_tiles :-
    new_memory_file(DataMemFile),
    open_memory_file(DataMemFile, write, Stream),
    save_data_stream(game, Stream),
    save_data_stream(tile, Stream),
    save_data_stream(legal_position, Stream),
    close(Stream),
    copy_memory_file_to_local_storage(DataMemFile, save_tiles),
    free_memory_file(DataMemFile).

load_tiles :-
    retract_all_data(game),
    retract_all_data(tile),
    retract_all_data(legal_position),
    copy_local_storage_to_memory_file(save_tiles, DataMemFile),
    wam_compiler:compile_and_free_memory_file(DataMemFile).


dummy_reference :-
    dummy_reference,
    select(_,_,_), % referenced indirectly in addEventListener/3 call.
    % following are generated by data_predicate_dynamics/1.
    tile_x(_),
    tile_y(_),
    tile_bx(_),
    tile_by(_),
    tile_size(_),
    tile_colors(_),
    tile_container(_),
    legal_position_bx(_),
    legal_position_by(_).

 % clientX and clientY are coordinates within the containing HTMLCanvasElement
 % It appears that the rendering coordinates (e.g. moveTo(RX, RY)) are coordinates
 % within the containing HTMLCanvasElement minus the canvas offset.
 % RX = clientX - offsetX.

select(Event, PTop, PLeft) :-
    Event >> [pageX +:> PageX, pageY +:> PageY],
    dom_release_object(Event),
    X is PageX - PLeft,
    Y is PageY - PTop,
    % writeln(select(PageX, PageY, PLeft, PTop, X, Y)),
    (point_in_tile(ID, X, Y)
      -> on_click_tile(ID, X, Y)  % at most one tile contains (X, Y).
    ;
     legal_position_bx(ID, BX),
     legal_position_by(ID, BY),
     point_in_board_position(BX, BY, X, Y)
      -> true
    ;
     true
    ).

point_in_tile(ID, MX, MY) :-
    tile_x(ID, TX),
    tile_y(ID, TY),
    tile_size(ID, Size),
    in_square(MX, MY, TX, TY, Size).

in_square(X, Y, Left, Top, Size) :-
    in_interval(X, Left, Left+Size),
    in_interval(Y, Top, Top+Size).

in_interval(V, Low, High) :-
    V >= Low,
    V =< High.

point_in_board_position(BX, BY, X, Y) :-
    game_tile_size(Size),
    board_position_top_left_coordinates(BX, BY, BCX, BCY),
    in_square(X, Y, BCX, BCY, Size).

board_position_top_left_coordinates(GridX, GridY, X, Y) :-
    game_tile_size(TileSize),
    game_board_left(BoardLeft),
    game_board_width(BoardWidth),
    game_board_top(BoardTop),
    game_board_height(BoardHeight),
    game_board_translate(TranslateX > TranslateY),
    X is BoardLeft + TranslateX + BoardWidth / 2 + (GridX - 0.5) * TileSize,
    Y is BoardTop + TranslateY + BoardHeight / 2 + (GridY - 0.5) * TileSize.

on_click_tile(ID, _X, _Y) :-
    %writeln(click(ID, X, Y)),
    (tile_in_active_hand(ID)
      -> on_click_active_hand_tile(ID)
    ;
    true % writeln(not_active)
    ).

on_click_active_hand_tile(ID) :-
    _ >> [id -:> canvas, getContext('2d') *:> Ctx],
    (retract(is_selected(OldID))
      -> draw_all_tile(OldID, Ctx) % de-select OldID
    ;
    true
    ),
    asserta(is_selected(ID)),
    draw_all_tile(ID, Ctx).


setup_hands([], []).
setup_hands([_+HandTiles|T], IDs) :-
    setup_hand(HandTiles, IDs, IDTail),
    setup_hands(T, IDTail).

setup_hand([], Tail, Tail).
setup_hand([H-ID|T], [ID|OtherIDs], IDTail) :-
    assert_data(H, ID),
    setup_hand(T, OtherIDs, IDTail).

hand_origin(1).

initial_hands_expanded(NumberOfPlayers, ExpandedHands) :-
    initial_hands(NumberOfPlayers, Hands),
    expand_hands(Hands, ExpandedHands).

expand_hands([], []).
expand_hands([H|T], [EH|ET]) :-
    expand_hand(H, EH),
    expand_hands(T, ET).

expand_hand(ID+BriefTiles, ID+ExpandedTiles) :-
    game_tile_size(Size),
    expand_brief_tiles(BriefTiles, ID, Size, ExpandedTiles).

expand_brief_tiles([], _, _, []).
expand_brief_tiles([H|T], HandID, Size, [EH|ET]) :-
    expand_brief_tile(H, HandID, Size, EH),
    expand_brief_tiles(T, HandID, Size, ET).

% [x, y,bx,by,size,colors,container]
expand_brief_tile(t(BoardX, BoardY, AbstractColors, TileID),
        HandID,
        Size,
        ts(X, Y, BoardX, BoardY, Size, Colors, container(HandID, hand))-TileID) :-
    X is BoardX * Size,
    Y is BoardY * Size,
    abstract_colors(AbstractColors, Colors).

abstract_colors([], []).
abstract_colors([AH|AT], [CH|CT]) :-
    abstract_color(AH, CH),
    abstract_colors(AT, CT).

abstract_color(a, red).
abstract_color(b, green).
abstract_color(c, blue).
abstract_color(d, yellow).

initial_hands(2, [1+Player1Tiles, 2+Player2Tiles]) :-
   Col1 is 1,
   Col2 is Col1 + 1,
   hand_origin(Origin1),
   Player1Row1 is Origin1,
   Player1Row2 is Origin1 + 1,
   Player1Row3 is Origin1 + 2,
   Player1Row4 is Origin1 + 3,
   Origin2 is Origin1 + 5,
   Player2Row1 is Origin2,
   Player2Row2 is Origin2 + 1,
   Player2Row3 is Origin2 + 2,
   Player2Row4 is Origin2 + 3,
   Player1Tiles = [ t(Col1, Player1Row1,[a,a,a,a], t01),
                            t(Col1, Player1Row2,[b,a,a,a], t02),
                            t(Col1, Player1Row3,[b,b,a,a], t03),
                            t(Col1, Player1Row4,[b,a,b,a], t04),
                            t(Col2, Player1Row1,[a,a,a,a], t05),
                            t(Col2, Player1Row2,[b,a,a,a], t06),
                            t(Col2, Player1Row3,[b,b,a,a], t07),
                            t(Col2, Player1Row4,[b,a,b,a], t08)
                           ],
   Player2Tiles = [t(Col1, Player2Row1,[b,b,b,b], t09),
                            t(Col1, Player2Row2,[a,b,b,b], t10),
                            t(Col1, Player2Row3,[a,a,b,b], t11),
                            t(Col1, Player2Row4,[a,b,a,b], t12),
                            t(Col2, Player2Row1,[b,b,b,b], t13),
                            t(Col2, Player2Row2,[a,b,b,b], t14),
                            t(Col2, Player2Row3,[a,a,b,b], t15),
                            t(Col2, Player2Row4,[a,b,a,b], t16)
                           ].

% (X > Y) is a point (X,Y).
% Web API method arguments of type number or integer accept arithmetic
% expressions; e.g. (1 + 0.5 * 50).

draw_tile(Ctx, Tile) :-
    tile_x(Tile, X),
    tile_y(Tile, Y),
    tile_size(Tile, Size),
    Corners = [X > Y,X + Size > Y,X + Size > Y + Size, X > Y + Size],
    Center = (X + 0.5 * Size > Y + 0.5 * Size),
    tile_colors(Tile, Colors),
    draw_triangles(Corners, Colors, Center, Ctx),
    tile_bx(Tile, BX),
    tile_by(Tile, BY),
    tile_label(BX, BY, Text),
    Ctx >> [
        save,
        fillStyle <:+ '#000',
        fillText(Text, X+5, Y+10),
        restore
    ].


draw_triangles([P1, P2|OtherCorners], [Color1|OtherColors], Center, Ctx) :-
   draw_triangle(P1, P2, Color1, Center, Ctx),
   draw_triangles1([P2|OtherCorners], OtherColors, P1, Center, Ctx).

draw_triangles1([P1], [Color], P2, Center, Ctx) :-
   draw_triangle(P1, P2, Color, Center, Ctx).
draw_triangles1([P1, P2|OtherCorners], [Color1|OtherColors], FirstP, Center, Ctx) :-
   draw_triangle(P1, P2, Color1, Center, Ctx),
   draw_triangles1([P2|OtherCorners], OtherColors, FirstP, Center, Ctx).

draw_triangle(P1x > P1y, P2x > P2y, Color, CenterX > CenterY, Ctx) :-
    Ctx >> [
        beginPath,
        moveTo(P1x, P1y),
        lineTo(P2x, P2y),
        lineTo(CenterX, CenterY),
        closePath,

        save,
        fillStyle <:+ Color,
        fill,
        stroke,
        restore
    ].

draw_all_tiles(AllTiles, Ctx, CW, CH) :-
    center_board,
    Ctx >> [
        fillStyle <:+ '#999',
        fillRect(0, 0, CW, CH)
    ],
    draw_all_tiles1(AllTiles, Ctx).

draw_all_tiles1([], _).
draw_all_tiles1([H|T], Ctx) :-
    draw_all_tile(H, Ctx),
    draw_all_tiles1(T, Ctx).

draw_all_tile(Tile, Ctx) :-
    (tile_in_inactive_hand(Tile) -> GlobalAlpha = 0.3; GlobalAlpha = 1),
    Ctx >> [
        save,
        globalAlpha <:+ GlobalAlpha
    ],
    draw_tile(Ctx, Tile),
    Ctx >*> restore,
    (is_selected(Tile)
        -> draw_selected_tile_mark(Tile, Ctx)
     ;
     true
    ),
    draw_replacements(Tile, Ctx).

draw_replacements(Tile, Ctx) :-
    (game_replacements(Rs),
     member(Tile, Rs)
       -> draw_replacement_tile_mark(Tile, Ctx)
    ;
    true
    ).

center_board.

draw_selected_tile_mark(Tile, Ctx) :-
    tile_x(Tile, X),
    tile_y(Tile, Y),
    tile_size(Tile, Size),

    MidX is X + (Size / 2),
    MidY is Y + (Size / 2),
    Adjust is Size / 4,

	VerticalTopX = MidX,
	VerticalTopY is MidY - Adjust,
	VerticalBottomX = MidX,
	VerticalBottomY is MidY + Adjust,
	HorizontalLeftX is MidX-Adjust,
	HorizontalLeftY = MidY,
	HorizontalRightX is MidX+Adjust,
	HorizontalRightY = MidY,

	game_turn(GT),
	highlight_color(GT, Color),

	Ctx >> [
	    save,

	    lineWidth <:+ 3,
	    strokeStyle <:+ Color,
	    beginPath,
	    moveTo(VerticalTopX, VerticalTopY),
	    lineTo(VerticalBottomX, VerticalBottomY),
	    closePath,
	    stroke,

	    beginPath,
	    moveTo(HorizontalLeftX, HorizontalLeftY),
	    lineTo(HorizontalRightX, HorizontalRightY),
	    closePath,
	    stroke,

	    restore
	].

draw_replacement_tile_mark(Tile, Ctx) :-
    tile_x(Tile, X),
    tile_y(Tile, Y),
    tile_size(Tile, Size),

    MidX is X + (Size / 2),
    MidY is Y + (Size / 2),
    Adjust is Size / 4,

	game_turn(GT),
	highlight_color(GT, Color),

	Ctx >> [
	    save,
	    lineWidth <:+ 3,
	    strokeStyle <:+ Color,
	    beginPath,
	    arc(MidX, MidY, Adjust, 0, 2*pi),
	    closePath,
	    stroke,
	    restore
	].

container_id(container(ID, _Type), ID).
container_type(container(_ID, Type), Type).

tile_label(BoardX, BoardY, Text) :-
    number_codes(BoardX, BXCodes),
    number_codes(BoardY, BYCodes),
    append_lists(["x", BXCodes, "y", BYCodes], TextCodes),
    atom_codes(Text, TextCodes).

tile_in_inactive_hand(Tile) :-
    tile_container(Tile, Container),
    container_type(Container, hand),
    game_turn(TurnID),
    \+ container_id(Container, TurnID).

tile_in_active_hand(Tile) :-
    tile_container(Tile, Container),
    container_type(Container, hand),
    game_turn(TurnID),
    container_id(Container, TurnID).

highlight_color(1, '#CCFFCC').
highlight_color(2, '#CCCCFF').
