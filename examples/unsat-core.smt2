; unsatisfiable: named assertions give an unsat core
(declare-const a Int)
(assert (! (> a 5) :named too-big))
(assert (! (< a 3) :named too-small))
(assert (! (> a 0) :named positive))
