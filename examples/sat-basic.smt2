; satisfiable: integer constraints with a Bool
(declare-const x Int)
(declare-const y Int)
(declare-const p Bool)
(assert (> x 2))
(assert (< y 10))
(assert (= (+ x (* 2 y)) 7))
(assert (= p (> x y)))
